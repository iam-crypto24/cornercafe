import { timeSlots, menuById } from '../services/catalog.js';
import { isCalendarDate, slotToTime } from '../validators/reservations.js';
import { AppError } from '../utils/errors.js';
import { reservationReference, sha256 } from '../utils/security.js';
import { withTransaction } from '../utils/database.js';

const sqlSlots = timeSlots.map(slotToTime);

function publicReceipt(reference, fields, table) {
  return {
    referenceNumber: reference,
    date: fields.date,
    timeSlot: fields.timeSlot,
    partySize: fields.partySize,
    table: { id: table.id, name: table.name, zone: table.zone, floor: table.floor, capacity: table.capacity },
    status: 'pending',
  };
}

function mapTable(row, isAvailable = true) {
  return {
    id: row.id, name: row.name, zone: row.zone, floor: row.floor,
    capacity: Number(row.capacity), isAvailable: Boolean(isAvailable),
    ...(row.layout && typeof row.layout === 'object' ? row.layout : {}),
  };
}

function mapPreOrders(rows) {
  return rows.map((row) => ({
    item: {
      id: row.menu_item_id, name: row.item_name, category: row.category,
      price: Number(row.unit_price), description: row.description || '',
    },
    quantity: Number(row.quantity),
  }));
}

function mapStaffBooking(row, preOrders) {
  return {
    id: row.id,
    referenceNumber: row.reference,
    date: row.visit_date,
    timeSlot: row.time_slot,
    partySize: Number(row.party_size),
    table: mapTable(row, true),
    preOrders,
    customerName: row.customer_name,
    customerPhone: row.customer_phone || '',
    customerEmail: row.customer_email || '',
    specialRequests: row.special_requests,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadPreOrders(client, reservationIds) {
  if (reservationIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT ri.reservation_id, ri.menu_item_id, ri.item_name, ri.quantity, ri.unit_price,
            mi.category, mi.description
     FROM reservation_items ri JOIN menu_items mi ON mi.id = ri.menu_item_id
     WHERE ri.reservation_id = ANY($1::uuid[])
     ORDER BY ri.reservation_id, ri.menu_item_id`,
    [reservationIds],
  );
  const output = new Map();
  for (const row of result.rows) {
    const items = output.get(row.reservation_id) || [];
    items.push(row);
    output.set(row.reservation_id, items);
  }
  return output;
}

export async function getAvailability(pool, { date, partySize, tableId }) {
  if (!isCalendarDate(date) || !Number.isInteger(partySize) || partySize < 1 || partySize > 8) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid date and party size.');
  }
  if (tableId) {
    const tableResult = await pool.query(
      'SELECT id, name, zone, floor, capacity, layout FROM cafe_tables WHERE id = $1 AND is_active = true AND capacity >= $2',
      [tableId, partySize],
    );
    if (!tableResult.rowCount) throw new AppError(404, 'TABLE_NOT_FOUND', 'That table is not available for this party size.');
    const result = await pool.query(
      `SELECT slot.start_time::text AS time
       FROM unnest($1::time[]) AS slot(start_time)
       WHERE NOT EXISTS (
         SELECT 1 FROM reservations r
         WHERE r.table_id = $2 AND r.visit_date = $3::date
           AND r.status IN ('pending', 'confirmed')
           AND r.during && tsrange($3::date + slot.start_time, $3::date + slot.start_time + interval '90 minutes', '[)')
       )
       ORDER BY slot.start_time`,
      [sqlSlots, tableId, date],
    );
    const slots = result.rows.map((row) => {
      const match = sqlSlots.indexOf(row.time);
      return timeSlots[match];
    }).filter(Boolean);
    return { date, partySize, tableId, availableSlots: slots };
  }
  const result = await pool.query(
    `SELECT t.id, t.name, t.zone, t.floor, t.capacity, t.layout,
       EXISTS (
         SELECT 1 FROM unnest($1::time[]) AS slot(start_time)
         WHERE NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.table_id = t.id AND r.visit_date = $2::date
             AND r.status IN ('pending', 'confirmed')
             AND r.during && tsrange($2::date + slot.start_time, $2::date + slot.start_time + interval '90 minutes', '[)')
         )
       ) AS is_available
     FROM cafe_tables t WHERE t.is_active = true AND t.capacity >= $3 ORDER BY t.floor, t.id`,
    [sqlSlots, date, partySize],
  );
  return { date, partySize, tables: result.rows.map((row) => mapTable(row, row.is_available)) };
}

export async function createReservation(pool, fields, { idempotencyKey, requestHash, timezone, duplicateWindowMs }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
        const prior = await client.query(
          'SELECT request_hash, response_json FROM idempotency_records WHERE idempotency_key = $1 AND expires_at > now() FOR UPDATE',
          [idempotencyKey],
        );
        if (prior.rowCount) {
          if (prior.rows[0].request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for different reservation details.');
          return prior.rows[0].response_json;
        }
        await client.query('DELETE FROM idempotency_records WHERE idempotency_key = $1 AND expires_at <= now()', [idempotencyKey]);

        const tableResult = await client.query(
          'SELECT id, name, zone, floor, capacity, is_active FROM cafe_tables WHERE id = $1 FOR SHARE',
          [fields.tableId],
        );
        const table = tableResult.rows[0];
        if (!table || !table.is_active) throw new AppError(404, 'TABLE_NOT_FOUND', 'That table is unavailable. Refresh the seating map and try again.');
        if (Number(table.capacity) < fields.partySize) throw new AppError(409, 'TABLE_CAPACITY', 'That table is too small for your party.');

        const duplicate = await client.query(
          `SELECT 1 FROM reservations
           WHERE visit_date = $1::date AND start_time = $2::time
             AND status <> 'cancelled' AND created_at >= now() - ($5::double precision * interval '1 millisecond')
             AND (($3::text IS NOT NULL AND customer_email = $3) OR ($4::text IS NOT NULL AND customer_phone = $4))
           LIMIT 1`,
          [fields.date, fields.startTime, fields.customerEmail, fields.customerPhone, duplicateWindowMs],
        );
        if (duplicate.rowCount) throw new AppError(409, 'DUPLICATE_RESERVATION', 'A recent request with these guest details already exists for this visit.');

        let reference = reservationReference();
        let reservationId;
        for (let refTry = 0; refTry < 4; refTry += 1) {
          await client.query('SAVEPOINT create_reservation_reference');
          try {
            const inserted = await client.query(
              `INSERT INTO reservations (
                 id, reference, visit_date, time_slot, start_time, timezone_name, party_size, table_id,
                 customer_name, customer_phone, customer_email, special_requests, status
               ) VALUES (gen_random_uuid(), $1, $2::date, $3, $4::time, $5, $6, $7, $8, $9, $10, $11, 'pending')
               RETURNING id`,
              [reference, fields.date, fields.timeSlot, fields.startTime, timezone, fields.partySize, fields.tableId,
                fields.customerName, fields.customerPhone, fields.customerEmail, fields.specialRequests],
            );
            reservationId = inserted.rows[0].id;
            await client.query('RELEASE SAVEPOINT create_reservation_reference');
            break;
          } catch (error) {
            if (error.code !== '23505' || error.constraint !== 'reservations_reference_key' || refTry === 3) throw error;
            await client.query('ROLLBACK TO SAVEPOINT create_reservation_reference');
            await client.query('RELEASE SAVEPOINT create_reservation_reference');
            reference = reservationReference();
          }
        }

        for (const preorder of fields.preOrders) {
          const item = menuById.get(preorder.menuItemId);
          if (!item) throw new AppError(400, 'VALIDATION_ERROR', 'A pre-order item is unavailable.');
          const insertedItem = await client.query(
            `INSERT INTO reservation_items (reservation_id, menu_item_id, item_name, quantity, unit_price)
             SELECT $1, mi.id, mi.name, $3, mi.price FROM menu_items mi
             WHERE mi.id = $2 AND mi.is_active = true
             RETURNING menu_item_id`,
            [reservationId, item.id, preorder.quantity],
          );
          if (!insertedItem.rowCount) throw new AppError(400, 'VALIDATION_ERROR', 'A pre-order item is unavailable.');
        }

        const response = publicReceipt(reference, fields, table);
        await client.query(
          `INSERT INTO idempotency_records (idempotency_key, request_hash, response_json, expires_at)
           VALUES ($1, $2, $3::jsonb, now() + interval '24 hours')`,
          [idempotencyKey, requestHash, JSON.stringify(response)],
        );
        await client.query(
          `INSERT INTO reservation_events (reservation_id, new_status) VALUES ($1, 'pending')`,
          [reservationId],
        );
        return response;
      });
    } catch (error) {
      if (error.code === '23P01') throw new AppError(409, 'SLOT_UNAVAILABLE', 'That table is no longer available at this time. Choose another slot.');
      if (error.code === '23505' && error.constraint === 'idempotency_records_pkey' && attempt < 4) continue;
      throw error;
    }
  }
  throw new AppError(503, 'SERVICE_BUSY', 'The reservation could not be completed. Please try again.');
}

export async function findPublicReservation(pool, reference) {
  if (!/^CC-[0-9A-HJKMNP-TV-Z]{26}$/.test(reference)) return null;
  const result = await pool.query('SELECT reference, status FROM reservations WHERE reference = $1', [reference]);
  if (!result.rowCount) return null;
  return { referenceNumber: result.rows[0].reference, status: result.rows[0].status };
}

export async function listReservations(pool, { date = '', status = 'all', search = '', limit = 500 }) {
  if (date && !isCalendarDate(date)) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid date filter.');
  if (!['all', 'pending', 'confirmed', 'cancelled'].includes(status)) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid status filter.');
  const safeSearch = String(search).trim().slice(0, 80).replace(/[\\%_]/g, '\\$&');
  const results = await pool.query(
    `SELECT r.*, t.name AS table_name, t.zone AS table_zone, t.floor AS table_floor,
            t.capacity AS table_capacity, t.layout AS table_layout
     FROM reservations r JOIN cafe_tables t ON t.id = r.table_id
     WHERE ($1::date IS NULL OR r.visit_date = $1::date)
       AND ($2 = 'all' OR r.status = $2)
       AND ($3 = '' OR r.customer_name ILIKE '%' || $3 || '%' ESCAPE '\\'
         OR r.reference ILIKE '%' || $3 || '%' ESCAPE '\\' OR r.table_id ILIKE '%' || $3 || '%' ESCAPE '\\')
     ORDER BY r.visit_date DESC, r.start_time DESC, r.created_at DESC
     LIMIT $4`,
    [date || null, status, safeSearch, Math.max(1, Math.min(limit, 1000))],
  );
  const items = await loadPreOrders(pool, results.rows.map((row) => row.id));
  const bookings = results.rows.map((row) => mapStaffBooking(row, mapPreOrders(items.get(row.id) || [])));
  return { bookings, truncated: results.rowCount === Math.min(limit, 1000) };
}

export async function updateReservationStatus(pool, id, status, adminId) {
  if (!['confirmed', 'cancelled'].includes(status)) throw new AppError(400, 'VALIDATION_ERROR', 'Choose confirmed or cancelled.');
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT r.*, t.name AS table_name, t.zone AS table_zone, t.floor AS table_floor,
              t.capacity AS table_capacity, t.layout AS table_layout
       FROM reservations r JOIN cafe_tables t ON t.id = r.table_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation was not found.');
    if (row.status === status) {
      const items = await loadPreOrders(client, [row.id]);
      return mapStaffBooking(row, mapPreOrders(items.get(row.id) || []));
    }
    if (row.status === 'cancelled') throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'A cancelled reservation cannot be restored.');
    const update = await client.query(
      `UPDATE reservations SET status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, adminId],
    );
    await client.query(
      `INSERT INTO reservation_events (reservation_id, actor_admin_id, previous_status, new_status)
       VALUES ($1, $2, $3, $4)`,
      [id, adminId, row.status, status],
    );
    const updated = { ...row, ...update.rows[0] };
    const items = await loadPreOrders(client, [id]);
    return mapStaffBooking(updated, mapPreOrders(items.get(id) || []));
  });
}

export async function getAdminTables(pool, date, timeSlot) {
  if (!isCalendarDate(date)) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid date.');
  const requested = timeSlot ? [slotToTime(timeSlot)] : sqlSlots;
  if (timeSlot && !requested[0]) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid time.');
  const result = await pool.query(
    `SELECT t.id, t.name, t.zone, t.floor, t.capacity, t.layout,
       EXISTS (
         SELECT 1 FROM unnest($1::time[]) AS slot(start_time)
         WHERE NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.table_id = t.id AND r.visit_date = $2::date
             AND r.status IN ('pending', 'confirmed')
             AND r.during && tsrange($2::date + slot.start_time, $2::date + slot.start_time + interval '90 minutes', '[)')
         )
       ) AS is_available
     FROM cafe_tables t ORDER BY t.floor, t.id`,
    [requested, date],
  );
  return { date, tables: result.rows.map((row) => mapTable(row, row.is_available)) };
}

export function reservationRequestHash(fields) {
  return sha256(JSON.stringify({
    date: fields.date, timeSlot: fields.timeSlot, partySize: fields.partySize, tableId: fields.tableId,
    customerName: fields.customerName, customerPhone: fields.customerPhone, customerEmail: fields.customerEmail,
    specialRequests: fields.specialRequests, preOrders: fields.preOrders,
  }));
}
