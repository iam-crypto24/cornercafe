import { randomUUID } from 'node:crypto';
import { createPool } from '../src/database/pool.js';
import { makePassword } from '../src/utils/password.js';
import { runMigrations } from '../src/database/migrations.js';
import { withTransaction } from '../src/utils/database.js';

const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const name = process.env.OWNER_NAME?.trim();
const password = process.env.OWNER_PASSWORD;
if (!email || !name || !password || password.length < 16 || password.length > 128
  || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 2 || name.length > 100) {
  throw new Error('Set OWNER_NAME, OWNER_EMAIL, and an OWNER_PASSWORD of 16–128 characters in your local shell.');
}
const pool = createPool(process.env);
try {
  await runMigrations(pool);
  const passwordHash = await makePassword(password);
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(871222411::bigint)');
    const owners = await client.query("SELECT COUNT(*)::integer AS count FROM admin_users WHERE role = 'owner' AND is_active = true");
    if (Number(owners.rows[0].count) > 0) throw new Error('An owner already exists. Use the owner dashboard to manage staff; this command creates only the first owner.');
    await client.query(
      `INSERT INTO admin_users (id, name, email, role, password_hash) VALUES ($1, $2, $3, 'owner', $4)`,
      [randomUUID(), name, email, passwordHash],
    );
  });
  console.log(JSON.stringify({ event: 'initial_owner_created' }));
} finally {
  await pool.end();
}
