import pg from 'pg';

const { Pool } = pg;

export function createPool(config = process.env) {
  if (!config.DATABASE_URL && !config.databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: config.databaseUrl || config.DATABASE_URL,
    max: Number(config.poolMax || config.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    application_name: 'corner-cafe-api',
  });
  pool.on('error', (error) => {
    console.error(JSON.stringify({ event: 'database_pool_error', code: error.code || 'DATABASE_ERROR' }));
  });
  return pool;
}
