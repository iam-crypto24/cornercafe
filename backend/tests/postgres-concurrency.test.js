import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { runMigrations } from '../src/database/migrations.js';
import { createPool } from '../src/database/pool.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase() : '';
const enabled = Boolean(databaseUrl && process.env.NODE_ENV === 'test' && databaseName.includes('test'));
let pool;
let server;
let baseUrl;
let emailA;
let emailB;
let visitDate;

test('real PostgreSQL accepts only one concurrent booking for the same table and time', { skip: !enabled }, async () => {
  const origin = 'http://127.0.0.1:5187';
  emailA = `concurrency-${randomUUID()}@example.test`;
  emailB = `concurrency-${randomUUID()}@example.test`;
  visitDate = '2199-12-28';
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    SESSION_SECRET: process.env.TEST_SESSION_SECRET || 'test-session-secret-at-least-thirty-two-characters',
    FRONTEND_ORIGIN: origin,
    ALLOWED_ORIGINS: origin,
    CAFE_TIME_ZONE: process.env.CAFE_TIME_ZONE || 'Asia/Kolkata',
    COOKIE_SECURE: 'false',
    BOT_FORM_MIN_AGE_MS: '1',
    TRUST_PROXY_HOPS: '0',
  });
  pool = createPool(config);
  await runMigrations(pool);
  const app = createApp({ pool, config });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const availabilityResponse = await fetch(`${baseUrl}/api/availability?date=${visitDate}&partySize=2`, { headers: { Origin: origin } });
  const { formToken } = await availabilityResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const send = (email, key) => fetch(`${baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({
      date: visitDate, timeSlot: '10:30 AM', partySize: 2, tableId: 'T1',
      customerName: 'Synthetic Concurrency Guest', customerPhone: '', customerEmail: email,
      specialRequests: '', preOrders: [], website: '', formToken,
    }),
  });
  const responses = await Promise.all([
    send(emailA, `concurrency-${randomUUID()}`),
    send(emailB, `concurrency-${randomUUID()}`),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && emailA && emailB && visitDate) {
    await pool.query("UPDATE reservations SET status='cancelled' WHERE visit_date=$1::date AND customer_email = ANY($2::text[])", [visitDate, [emailA, emailB]]).catch(() => {});
  }
  if (pool) await pool.end();
});
