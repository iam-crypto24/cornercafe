import { createPool } from './pool.js';
import { runMigrations } from './migrations.js';

const pool = createPool(process.env);
try {
  await runMigrations(pool);
  console.log(JSON.stringify({ event: 'database_migrations_complete' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'database_migration_failed', code: error.code || 'MIGRATION_ERROR' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
