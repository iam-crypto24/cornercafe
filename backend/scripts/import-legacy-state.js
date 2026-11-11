import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename as renameFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '../src/database/pool.js';
import { runMigrations } from '../src/database/migrations.js';
import { reservationReference } from '../src/utils/security.js';
import { isCalendarDate, slotToTime } from '../src/validators/reservations.js';
import { timeSlots } from '../src/services/catalog.js';
import { withTransaction } from '../src/utils/database.js';
import { hasControlCharacters } from '../src/utils/validation.js';

const fileArgument = process.argv[2];
if (!fileArgument || process.argv.length > 3) throw new Error('Usage: npm run db:import-legacy -- <path-to-exported-state.json>');
const file = path.resolve(process.cwd(), fileArgument);
const raw = await readFile(file);
if (raw.byteLength > 10 * 1024 * 1024) throw new Error('Legacy state exceeds the 10 MB migration safety limit.');
const state = JSON.parse(raw.toString('utf8'));
if (!state || state.version !== 1 || !Array.isArray(state.admins) || !Array.isArray(state.bookings) || !Array.isArray(state.tables)) {
  throw new Error('Legacy state has an unsupported structure. No records were imported.');
}
const sourceHash = createHash('sha256').update(raw).digest('hex');
const sourceName = 'vercel-blob-state-v1';
const pool = createPool(process.env);

function requiredString(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || hasControlCharacters(value)) throw new Error(`Legacy ${label} is invalid. No records were imported.`);
  return value.trim();
}
function normalizeTable(table) {
  if (!table || typeof table !== 'object' || !/^T(?:[1-9]|1[0-9]|2[0-7])$/.test(table.id)
    || !['Window', 'Indoor', 'Patio'].includes(table.zone) || ![1, 2, 3].includes(Number(table.floor))
    || !Number.isInteger(Number(table.capacity)) || Number(table.capacity) < 1 || Number(table.capacity) > 12) {
    throw new Error('Legacy seating data contains an unsupported table. No records were imported.');
  }
  return {
    id: table.id, name: requiredString(table.name, 1, 120, 'table name'), zone: table.zone,
    floor: Number(table.floor), capacity: Number(table.capacity),
    isActive: table.isActive !== false,
    layout: table.layout && typeof table.layout === 'object' ? table.layout : {
      x: Number(table.x) || 0, y: Number(table.y) || 0, width: Number(table.width) || 52,
      height: Number(table.height) || 52, shape: table.shape || 'rect',
      description: typeof table.description === 'string' ? table.description.slice(0, 500) : '',
      features: Array.isArray(table.features) ? table.features.filter((item) => typeof item === 'string').slice(0, 20) : [],
    },
  };
}
function normalizeAdmin(admin) {
  if (!admin || !['owner', 'staff'].includes(admin.role)) throw new Error('Legacy admin data contains an unsupported role. No records were imported.');
  const email = requiredString(admin.email, 3, 254, 'admin email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Legacy admin data contains an invalid email. No records were imported.');
  const passwordHash = typeof admin.passwordHash === 'string' ? admin.passwordHash : '';
  if (!/^scrypt\$16384\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(passwordHash)) {
    throw new Error('A legacy account has a password hash that this importer cannot verify. No data was imported; prepare a secure password reset for that account before retrying.');
  }
  return {
    id: typeof admin.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admin.id) ? admin.id : randomUUID(),
    legacyId: typeof admin.id === 'string' ? admin.id : '',
    name: requiredString(admin.name, 2, 100, 'admin name'), email,
    role: admin.role, passwordHash, isActive: admin.isActive !== false,
  };
}
function normalizeBooking(booking, tableIds) {
  const date = booking?.date;
  const timeSlot = booking?.timeSlot;
  const partySize = Number(booking?.partySize);
  const tableId = booking?.table?.id;
  if (!isCalendarDate(date) || !timeSlots.includes(timeSlot) || !Number.isInteger(partySize) || partySize < 1 || partySize > 8 || !tableIds.has(tableId)) {
    throw new Error('Legacy reservation data contains an invalid date, slot, party size, or table. No records were imported.');
  }
  const phoneRaw = typeof booking.customerPhone === 'string' ? booking.customerPhone.trim() : '';
  const emailRaw = typeof booking.customerEmail === 'string' ? booking.customerEmail.trim().toLowerCase() : '';
  const phoneDigits = phoneRaw.replace(/\D/g, '');
  if (phoneRaw && (phoneRaw.length > 40 || !/^\+?[\d().\-\s]+$/.test(phoneRaw) || phoneDigits.length < 7 || phoneDigits.length > 15)) {
    throw new Error('A legacy reservation has an invalid guest phone. No records were imported.');
  }
  const customerPhone = phoneRaw ? `${phoneRaw.startsWith('+') ? '+' : ''}${phoneDigits}` : null;
  const customerEmail = emailRaw || null;
  if (!customerPhone && !customerEmail) throw new Error('A legacy reservation has no usable guest contact. No records were imported.');
  if (customerEmail && (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) throw new Error('A legacy reservation has an invalid guest email. No records were imported.');
  if (!['pending', 'confirmed', 'cancelled'].includes(booking.status)) throw new Error('Legacy reservation data contains an unsupported status. No records were imported.');
  const customerName = requiredString(booking.customerName, 2, 100, 'guest name');
  if (hasControlCharacters(customerName)) throw new Error('A legacy reservation has an invalid guest name. No records were imported.');
  const preOrders = Array.isArray(booking.preOrders) ? booking.preOrders : [];
  if (preOrders.length > 20) throw new Error('A legacy reservation has too many pre-order entries. No records were imported.');
  return {
    id: randomUUID(), legacyReference: typeof booking.referenceNumber === 'string' ? booking.referenceNumber : null,
    date, timeSlot, startTime: slotToTime(timeSlot), partySize, tableId,
    customerName,
    customerPhone, customerEmail,
    specialRequests: typeof booking.specialRequests === 'string' ? booking.specialRequests : '',
    status: booking.status,
    legacyReviewedBy: typeof booking.reviewedBy === 'string' ? booking.reviewedBy : null,
    reviewedAt: Number.isFinite(Date.parse(booking.reviewedAt)) ? new Date(booking.reviewedAt) : null,
    createdAt: Number.isFinite(Date.parse(booking.createdAt)) ? new Date(booking.createdAt) : new Date(),
    preOrders: preOrders.map((entry) => {
      const item = entry?.item || entry;
      const quantity = Number(entry?.quantity);
      const id = item?.id;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw new Error('Legacy pre-order data contains an invalid item. No records were imported.');
      }
      const name = requiredString(item.name, 1, 160, 'menu item name');
      const category = requiredString(item.category || 'Imported', 1, 80, 'menu category');
      const price = Number(item.price);
      if (!Number.isFinite(price) || price < 0 || price > 100_000) throw new Error('Legacy pre-order data contains an invalid price. No records were imported.');
      return { id, name, category, price, description: typeof item.description === 'string' ? item.description : '', quantity };
    }),
  };
}

const tables = state.tables.map(normalizeTable);
const tableIds = new Set(tables.map((table) => table.id));
if (tableIds.size !== tables.length) throw new Error('Legacy seating data contains duplicate table IDs. No records were imported.');
const admins = state.admins.map(normalizeAdmin);
if (new Set(admins.map((admin) => admin.email)).size !== admins.length) throw new Error('Legacy admin data contains duplicate email addresses. No records were imported.');
if (new Set(admins.map((admin) => admin.id)).size !== admins.length) throw new Error('Legacy admin data contains duplicate account IDs. No records were imported.');
const bookings = state.bookings.map((booking) => normalizeBooking(booking, tableIds));
for (const booking of bookings) {
  if (booking.legacyReference && booking.legacyReference.length > 200) throw new Error('Legacy reservation data contains an oversized reference. No records were imported.');
  if (booking.specialRequests.length > 1000 || hasControlCharacters(booking.specialRequests, { allowFormattingWhitespace: true })) {
    throw new Error('A legacy reservation has an invalid special request. No records were imported.');
  }
  const seenItems = new Set();
  for (const item of booking.preOrders) {
    if (seenItems.has(item.id)) throw new Error('Legacy reservation data contains duplicate pre-order items. No records were imported.');
    seenItems.add(item.id);
    if (item.description.length > 500 || hasControlCharacters(item.description, { allowFormattingWhitespace: true })) throw new Error('Legacy menu data contains an invalid description. No records were imported.');
  }
}
const mapOutput = `${path.dirname(file)}${path.sep}corner-cafe.reference-map.json`;
let referenceMappings = [];

try {
  await runMigrations(pool);
  const existing = await pool.query('SELECT content_hash FROM data_imports WHERE source = $1', [sourceName]);
  if (existing.rowCount) {
    if (existing.rows[0].content_hash !== sourceHash) throw new Error('A different legacy export was already imported. Review it manually; no data was changed.');
    console.log(JSON.stringify({ event: 'legacy_import_skipped', reason: 'identical_export_already_imported', sha256: sourceHash }));
  } else {
    const occupied = await pool.query('SELECT (SELECT COUNT(*) FROM reservations)::integer AS reservations, (SELECT COUNT(*) FROM admin_users)::integer AS admins');
    if (Number(occupied.rows[0].reservations) || Number(occupied.rows[0].admins)) throw new Error('The destination database already contains reservations or staff accounts. Import stopped to prevent overwriting or mixing data.');

    await withTransaction(pool, async (client) => {
      for (const table of tables) {
        await client.query(
          `INSERT INTO cafe_tables (id, name, zone, floor, capacity, is_active, layout)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, zone = EXCLUDED.zone,
             floor = EXCLUDED.floor, capacity = EXCLUDED.capacity, is_active = EXCLUDED.is_active,
             layout = EXCLUDED.layout, updated_at = now()`,
          [table.id, table.name, table.zone, table.floor, table.capacity, table.isActive, JSON.stringify(table.layout)],
        );
      }
      for (const admin of admins) {
        await client.query(
          `INSERT INTO admin_users (id, name, email, role, password_hash, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [admin.id, admin.name, admin.email, admin.role, admin.passwordHash, admin.isActive],
        );
      }
      const adminIdsByLegacyId = new Map(admins.filter((admin) => admin.legacyId).map((admin) => [admin.legacyId, admin.id]));
      for (const booking of bookings) {
        const reference = reservationReference();
        const reviewedBy = booking.legacyReviewedBy ? adminIdsByLegacyId.get(booking.legacyReviewedBy) || null : null;
        const inserted = await client.query(
          `INSERT INTO reservations (
             id, reference, legacy_reference, visit_date, time_slot, start_time, timezone_name,
             party_size, table_id, customer_name, customer_phone, customer_email,
             special_requests, status, created_at, updated_at, reviewed_by, reviewed_at
           ) VALUES ($1, $2, $3, $4::date, $5, $6::time, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16, $17)
           RETURNING id`,
          [booking.id, reference, booking.legacyReference, booking.date, booking.timeSlot, booking.startTime,
            process.env.CAFE_TIME_ZONE, booking.partySize, booking.tableId, booking.customerName,
            booking.customerPhone, booking.customerEmail, booking.specialRequests, booking.status, booking.createdAt, reviewedBy, booking.reviewedAt],
        );
        for (const item of booking.preOrders) {
          await client.query(
            `INSERT INTO menu_items (id, name, category, price, description, is_active)
             VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT (id) DO NOTHING`,
            [item.id, item.name, item.category, item.price, item.description],
          );
          await client.query(
            `INSERT INTO reservation_items (reservation_id, menu_item_id, item_name, quantity, unit_price)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reservation_id, menu_item_id) DO NOTHING`,
            [inserted.rows[0].id, item.id, item.name, item.quantity, item.price],
          );
        }
        await client.query(
          `INSERT INTO reservation_events (reservation_id, actor_admin_id, previous_status, new_status, created_at)
           VALUES ($1, $2, NULL, $3, $4)`,
          [inserted.rows[0].id, reviewedBy, booking.status, booking.createdAt],
        );
      }
      await client.query('DELETE FROM sessions');
      await client.query(
        `INSERT INTO data_imports (source, content_hash, reservation_count, admin_count, table_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [sourceName, sourceHash, bookings.length, admins.length, tables.length],
      );
      const importedCounts = await client.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM reservations) AS reservations,
           (SELECT COUNT(*)::integer FROM admin_users) AS admins,
           (SELECT COUNT(*)::integer FROM cafe_tables WHERE id = ANY($1::text[])) AS tables`,
        [tables.map((table) => table.id)],
      );
      const actual = importedCounts.rows[0];
      if (Number(actual.reservations) !== bookings.length || Number(actual.admins) !== admins.length || Number(actual.tables) !== tables.length) {
        throw new Error('Database record counts did not match the legacy export. Transaction rolled back.');
      }
    });
    const importedReferences = await pool.query(
      'SELECT legacy_reference, reference FROM reservations WHERE legacy_reference IS NOT NULL ORDER BY created_at, id',
    );
    referenceMappings = importedReferences.rows.map(({ legacy_reference: oldReference, reference }) => ({ oldReference, newReference: reference }));
    console.log(JSON.stringify({ event: 'legacy_import_complete', sha256: sourceHash, reservations: bookings.length, admins: admins.length, tables: tables.length }));
  }
  if (!referenceMappings.length && existing.rowCount) {
    const importedReferences = await pool.query(
      'SELECT legacy_reference, reference FROM reservations WHERE legacy_reference IS NOT NULL ORDER BY created_at, id',
    );
    referenceMappings = importedReferences.rows.map(({ legacy_reference: oldReference, reference }) => ({ oldReference, newReference: reference }));
  }
  if (referenceMappings.length) {
    const temporaryMap = `${mapOutput}.${randomUUID()}.partial`;
    await writeFile(temporaryMap, `${JSON.stringify({ generatedAt: new Date().toISOString(), mappings: referenceMappings }, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    await renameFile(temporaryMap, mapOutput);
    console.log(JSON.stringify({ event: 'legacy_reference_map_written', output: path.basename(mapOutput), count: referenceMappings.length }));
  }
} finally {
  await pool.end();
}
