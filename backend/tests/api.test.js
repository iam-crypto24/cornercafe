import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { runMigrations } from '../src/database/migrations.js';
import { makePassword } from '../src/utils/password.js';
import { withTransaction } from '../src/utils/database.js';

const origin = 'http://127.0.0.1:5173';
let database;
let pool;
let server;
let baseUrl;
let owner;
let staff;

function adaptResult(result) {
  const item = Array.isArray(result) ? result.at(-1) : result;
  return { ...item, rowCount: Math.max(item?.affectedRows ?? 0, item?.rows?.length ?? 0) };
}

function createTestPool(db) {
  const query = async (sql, params = []) => {
    const result = sql.includes('CREATE EXTENSION IF NOT EXISTS btree_gist')
      ? await db.exec(sql)
      : await db.query(sql, params);
    return adaptResult(result);
  };
  return {
    query,
    async connect() { return { query, release() {} }; },
    async end() { await db.close(); },
  };
}

async function request(path, { method = 'GET', body, cookie, csrf, requestOrigin = origin, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (requestOrigin) requestHeaders.set('Origin', requestOrigin);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (cookie) requestHeaders.set('Cookie', cookie);
  if (csrf) requestHeaders.set('X-CSRF-Token', csrf);
  return fetch(`${baseUrl}${path}`, { method, headers: requestHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function signIn(email, password) {
  const response = await request('/api/admin/auth?action=login', { method: 'POST', body: { email, password } });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

before(async () => {
  database = new PGlite({ extensions: { btree_gist } });
  pool = createTestPool(database);
  await runMigrations(pool);
  const ownerHash = await makePassword('Owner test password 123!');
  const staffHash = await makePassword('Staff test password 123!');
  owner = '10000000-0000-4000-8000-000000000001';
  staff = '10000000-0000-4000-8000-000000000002';
  await pool.query("INSERT INTO admin_users (id,name,email,role,password_hash) VALUES ($1,'Owner','owner@example.test','owner',$2),($3,'Staff','staff@example.test','staff',$4)", [owner, ownerHash, staff, staffHash]);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@localhost/test', SESSION_SECRET: 'test-session-secret-at-least-thirty-two-characters',
    FRONTEND_ORIGIN: origin, ALLOWED_ORIGINS: origin, CAFE_TIME_ZONE: 'Asia/Kolkata', COOKIE_SECURE: 'false',
    RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX_REQUESTS: '200', LOGIN_RATE_LIMIT_MAX: '8', LOGIN_IP_RATE_LIMIT_MAX: '30',
    BOOKING_RATE_LIMIT_MAX: '10', BOOKING_CONTACT_RATE_LIMIT_MAX: '4', LOOKUP_RATE_LIMIT_MAX: '5', BOT_FORM_MIN_AGE_MS: '1',
  });
  const app = createApp({ pool, config });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

test('migrations seed all 27 tables and 9 menu items; rerunning is safe', async () => {
  const counts = await pool.query('SELECT (SELECT count(*) FROM cafe_tables)::int AS tables, (SELECT count(*) FROM menu_items)::int AS menu');
  assert.deepEqual(counts.rows[0], { tables: 27, menu: 9 });
  await runMigrations(pool);
  const migrations = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  assert.equal(migrations.rows[0].count, 1);
});

test('valid login creates HttpOnly secure-configured session; bad logins are generic and rate limited', async () => {
  const valid = await signIn('owner@example.test', 'Owner test password 123!');
  assert.equal(valid.response.status, 200);
  assert.match(valid.cookie, /^corner_cafe_session=/);
  assert.match(valid.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal(valid.data.admin.role, 'owner');
  assert.equal(typeof valid.data.csrfToken, 'string');
  const freshLogin = await signIn('owner@example.test', 'Owner test password 123!');
  assert.notEqual(freshLogin.cookie, valid.cookie);
  assert.equal((await request('/api/admin/auth?action=session', { cookie: valid.cookie })).status, 401);

  const badAttempts = await Promise.all(Array.from({ length: 8 }, () => signIn('missing@example.test', 'wrong')));
  const limited = await signIn('missing@example.test', 'wrong');
  assert.ok(badAttempts.every((attempt) => attempt.response.status === 401));
  assert.equal(limited.response.status, 429);
  assert.equal(badAttempts[0].data.error.message, 'Email or password was not recognised.');
});

test('every protected admin route requires authentication; staff cannot create or change accounts', async () => {
  assert.equal((await request('/api/admin/reservations')).status, 401);
  assert.equal((await request('/api/admin/tables')).status, 401);
  assert.equal((await request('/api/admin/users')).status, 401);
  const login = await signIn('staff@example.test', 'Staff test password 123!');
  const forbidden = await request('/api/admin/users', { method: 'POST', cookie: login.cookie, csrf: login.data.csrfToken, body: { name: 'Attacker', email: 'attacker@example.test', password: 'Not a real secret 123!', role: 'owner' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM admin_users WHERE email='attacker@example.test'")).rows[0].count, 0);
});

test('owner mutations enforce allowlisted Origin and session CSRF token', async () => {
  const login = await signIn('owner@example.test', 'Owner test password 123!');
  const noCsrf = await request('/api/admin/users', { method: 'POST', cookie: login.cookie, body: { name: 'New Staff', email: 'new@example.test', password: 'A secure temporary 123!' } });
  assert.equal(noCsrf.status, 403);
  const badOrigin = await request('/api/admin/users', { method: 'POST', cookie: login.cookie, csrf: login.data.csrfToken, requestOrigin: 'https://attacker.example', body: { name: 'New Staff', email: 'new@example.test', password: 'A secure temporary 123!' } });
  assert.equal(badOrigin.status, 403);
  const missingOrigin = await request('/api/admin/users', { method: 'POST', cookie: login.cookie, csrf: login.data.csrfToken, requestOrigin: '', body: { name: 'New Staff', email: 'new@example.test', password: 'A secure temporary 123!' } });
  assert.equal(missingOrigin.status, 403);
  const created = await request('/api/admin/users', { method: 'POST', cookie: login.cookie, csrf: login.data.csrfToken, body: { name: 'New Staff', email: 'new@example.test', password: 'A secure temporary 123!', role: 'owner' } });
  const result = await created.json();
  assert.equal(created.status, 201);
  assert.equal(result.admin.role, 'staff');
  assert.equal('passwordHash' in result.admin, false);
});

test('reservation references are unguessable-style format and public lookup reveals no guest details', async () => {
  const available = await request('/api/availability?date=2099-01-15&partySize=2');
  const availableData = await available.json();
  assert.equal(available.status, 200);
  assert.equal(availableData.tables.length, 27);
  assert.equal(typeof availableData.formToken, 'string');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const payload = {
    date: '2099-01-15', timeSlot: '10:30 AM', partySize: 2, tableId: 'T1',
    customerName: '<script>alert(1)</script>', customerPhone: '+1 (555) 111-2233', customerEmail: 'guest@example.test',
    specialRequests: 'Window seat', preOrders: [{ menuItemId: 'm1', quantity: 2 }], website: '', formToken: availableData.formToken,
  };
  const headers = { 'Idempotency-Key': 'test-idempotency-key-0001' };
  const response = await request('/api/reservations', { method: 'POST', body: payload, headers });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.match(data.booking.referenceNumber, /^CC-[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(data.booking.customerName, undefined);
  assert.equal(data.booking.customerPhone, undefined);
  assert.equal(data.booking.specialRequests, undefined);

  const lookup = await request(`/api/reservation-status?reference=${data.booking.referenceNumber}`);
  const lookupData = await lookup.json();
  assert.deepEqual(lookupData, { referenceNumber: data.booking.referenceNumber, status: 'pending' });
  const missing = await request('/api/reservation-status?reference=CC-00000000000000000000000000');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.message, (await (await request('/api/reservation-status?reference=CC-00000000000000000000000001')).json()).error.message);

  const repeated = await request('/api/reservations', { method: 'POST', body: payload, headers });
  assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).booking.referenceNumber, data.booking.referenceNumber);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM reservations')).rows[0].count, 1);
});

test('reservation validation, origin validation, duplicate prevention, and table overlap are enforced', async () => {
  const availability = await request('/api/availability?date=2099-01-16&partySize=2');
  const { formToken } = await availability.json();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const base = { date: '2099-01-16', timeSlot: '10:30 AM', partySize: 2, tableId: 'T1', customerName: 'Guest Name', customerPhone: '+15551112233', customerEmail: '', specialRequests: '', preOrders: [], website: '', formToken };
  const invalid = await request('/api/reservations', { method: 'POST', body: { ...base, date: '2099-02-31' }, headers: { 'Idempotency-Key': 'test-invalid-date-key' } });
  assert.equal(invalid.status, 400);
  const originRejected = await request('/api/reservations', { method: 'POST', requestOrigin: 'https://evil.example', body: base, headers: { 'Idempotency-Key': 'test-invalid-origin-key' } });
  assert.equal(originRejected.status, 403);
  const noOrigin = await request('/api/reservations', { method: 'POST', requestOrigin: '', body: base, headers: { 'Idempotency-Key': 'test-no-origin-key' } });
  assert.equal(noOrigin.status, 403);
  const first = await request('/api/reservations', { method: 'POST', body: base, headers: { 'Idempotency-Key': 'test-overlap-first-key' } });
  assert.equal(first.status, 201);
  const duplicate = await request('/api/reservations', { method: 'POST', body: { ...base, customerName: 'Different Name' }, headers: { 'Idempotency-Key': 'test-overlap-second-key' } });
  assert.equal(duplicate.status, 409);
  const badSlot = await request('/api/availability?date=2099-01-16&partySize=2&tableId=T1%27%20OR%201=1');
  assert.equal(badSlot.status, 400);
});

test('database exclusion constraint blocks overlapping reservation intervals', async () => {
  await pool.query(`INSERT INTO reservations (id, reference, visit_date, time_slot, start_time, timezone_name, party_size, table_id, customer_name, customer_phone)
    VALUES ('10000000-0000-4000-8000-000000000010','CC-00000000000000000000000010','2099-02-01','10:30 AM','10:30','Asia/Kolkata',2,'T2','First Guest','5551112233')`);
  await assert.rejects(
    pool.query(`INSERT INTO reservations (id, reference, visit_date, time_slot, start_time, timezone_name, party_size, table_id, customer_name, customer_phone)
      VALUES ('10000000-0000-4000-8000-000000000011','CC-00000000000000000000000011','2099-02-01','11:30 AM','11:30','Asia/Kolkata',2,'T2','Second Guest','5551112244')`),
    (error) => error.code === '23P01',
  );
});

test('database transactions roll back all writes on failure', async () => {
  await assert.rejects(withTransaction(pool, async (client) => {
    await client.query("INSERT INTO security_events (event_type) VALUES ('test_rollback')");
    throw new Error('rollback requested');
  }), /rollback requested/);
  const result = await pool.query("SELECT count(*)::int AS count FROM security_events WHERE event_type='test_rollback'");
  assert.equal(result.rows[0].count, 0);
});

test('a password change requires the current password and revokes prior sessions', async () => {
  const added = await pool.query("INSERT INTO admin_users (id,name,email,role,password_hash) VALUES ('10000000-0000-4000-8000-000000000003','Password Test','password@example.test','staff',$1) RETURNING id", [await makePassword('Old password 123456!')]);
  const user = await signIn('password@example.test', 'Old password 123456!');
  const badCurrent = await request('/api/admin/auth/password', { method: 'POST', cookie: user.cookie, csrf: user.data.csrfToken, body: { currentPassword: 'wrong', newPassword: 'New password 123456!' } });
  assert.equal(badCurrent.status, 401);
  const changed = await request('/api/admin/auth/password', { method: 'POST', cookie: user.cookie, csrf: user.data.csrfToken, body: { currentPassword: 'Old password 123456!', newPassword: 'New password 123456!' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/admin/auth?action=session', { cookie: user.cookie })).status, 401);
  assert.equal((await signIn('password@example.test', 'Old password 123456!')).response.status, 401);
  assert.equal((await signIn('password@example.test', 'New password 123456!')).response.status, 200);
  assert.ok(added.rows[0].id);
});

test('malformed and oversized JSON return safe errors without stack details', async () => {
  const malformed = await fetch(`${baseUrl}/api/reservations`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  const oversized = await fetch(`${baseUrl}/api/reservations`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(40_000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.text()).includes('stack'), false);
});

test('reservation status update is staff-authorized and cancellation cannot be undone', async () => {
  const staffLogin = await signIn('staff@example.test', 'Staff test password 123!');
  const reservation = (await pool.query("SELECT id FROM reservations WHERE visit_date='2099-01-15'::date LIMIT 1")).rows[0];
  const noCsrf = await request(`/api/admin/reservation?id=${reservation.id}`, { method: 'PATCH', cookie: staffLogin.cookie, body: { status: 'cancelled' } });
  assert.equal(noCsrf.status, 403);
  const cancelled = await request(`/api/admin/reservation?id=${reservation.id}`, { method: 'PATCH', cookie: staffLogin.cookie, csrf: staffLogin.data.csrfToken, body: { status: 'cancelled' } });
  assert.equal(cancelled.status, 200);
  const restore = await request(`/api/admin/reservation?id=${reservation.id}`, { method: 'PATCH', cookie: staffLogin.cookie, csrf: staffLogin.data.csrfToken, body: { status: 'confirmed' } });
  assert.equal(restore.status, 409);
});

test('account deactivation revokes active sessions and logout revokes a session', async () => {
  const ownerLogin = await signIn('owner@example.test', 'Owner test password 123!');
  const staffLogin = await signIn('staff@example.test', 'Staff test password 123!');
  const staffId = (await pool.query("SELECT id FROM admin_users WHERE email='staff@example.test'")).rows[0].id;
  const deactivate = await request(`/api/admin/user?id=${staffId}`, { method: 'PATCH', cookie: ownerLogin.cookie, csrf: ownerLogin.data.csrfToken, body: { isActive: false } });
  assert.equal(deactivate.status, 200);
  assert.equal((await request('/api/admin/auth?action=session', { cookie: staffLogin.cookie })).status, 401);
  const reactivate = await request(`/api/admin/user?id=${staffId}`, { method: 'PATCH', cookie: ownerLogin.cookie, csrf: ownerLogin.data.csrfToken, body: { isActive: true } });
  assert.equal(reactivate.status, 200);
  const newStaffLogin = await signIn('staff@example.test', 'Staff test password 123!');
  const logoutResponse = await request('/api/admin/auth/logout', { method: 'POST', cookie: newStaffLogin.cookie, csrf: newStaffLogin.data.csrfToken });
  assert.equal(logoutResponse.status, 200);
  assert.equal((await request('/api/admin/auth?action=session', { cookie: newStaffLogin.cookie })).status, 401);
});

test('expired sessions are rejected server-side and customer modification routes do not exist', async () => {
  const login = await signIn('owner@example.test', 'Owner test password 123!');
  const token = decodeURIComponent(login.cookie.split('=')[1]);
  const { sha256 } = await import('../src/utils/security.js');
  await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [sha256(token)]);
  assert.equal((await request('/api/admin/auth?action=session', { cookie: login.cookie })).status, 401);
  const modification = await request('/api/reservations/CC-00000000000000000000000000', { method: 'PATCH', body: { status: 'confirmed' } });
  assert.equal(modification.status, 404);
});

test('health check does not leak database URL and rejects untrusted CORS origins', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'corner-cafe-api', storage: 'postgresql' });
  const denied = await request('/api/health', { requestOrigin: 'https://evil.example' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes('DATABASE_URL'), false);
});
