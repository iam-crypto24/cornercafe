import { loadConfig } from './config/env.js';
import { createPool } from './database/pool.js';
import { runMigrations } from './database/migrations.js';
import { createApp } from './app.js';
import { pruneExpiredSecurityData } from './database/maintenance.js';

const config = loadConfig();
const pool = createPool(config);
try {
  await runMigrations(pool);
} catch (error) {
  console.error(JSON.stringify({ event: 'startup_migration_failed', code: error.code || 'MIGRATION_ERROR' }));
  await pool.end();
  process.exit(1);
}
const app = createApp({ pool, config });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'server_started', port: config.port, environment: config.nodeEnv }));
});

const cleanupTimer = setInterval(() => {
  void pruneExpiredSecurityData(pool).catch((error) => {
    console.error(JSON.stringify({ event: 'security_data_cleanup_failed', code: error.code || 'DATABASE_ERROR' }));
  });
}, 60 * 60 * 1000);
cleanupTimer.unref();

server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = Math.min(65_000, config.requestTimeoutMs + 5_000);
server.keepAliveTimeout = 5_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'server_shutdown', signal }));
  clearInterval(cleanupTimer);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    try { await pool.end(); process.exit(0); }
    catch { process.exit(1); }
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
