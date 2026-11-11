import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalog } from '../services/catalog.js';

const migrationDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_LOCK = 871_222_410;

export async function seedCatalog(client) {
  for (const table of catalog.tables) {
    const { id, name, zone, floor, capacity, layout } = table;
    await client.query(
      `INSERT INTO cafe_tables (id, name, zone, floor, capacity, is_active, layout)
       VALUES ($1, $2, $3, $4, $5, true, $6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, zone, floor, capacity, JSON.stringify(layout || {})],
    );
  }
  for (const item of catalog.menuItems) {
    await client.query(
      `INSERT INTO menu_items (id, name, category, price, description, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.name, item.category, item.price, item.description || ''],
    );
  }
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK]);
    const files = await readdir(migrationDirectory);
    for (const name of files.filter((entry) => /^\d+_[a-z0-9_-]+\.sql$/.test(entry)).sort()) {
      const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query('BEGIN');
    try {
      await seedCatalog(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK]); } catch { /* The connection may already be closed. */ }
    client.release();
  }
}
