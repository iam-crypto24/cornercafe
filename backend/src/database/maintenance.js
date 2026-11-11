export async function pruneExpiredSecurityData(pool) {
  const statements = [
    "DELETE FROM rate_limit_buckets WHERE expires_at <= now()",
    "DELETE FROM idempotency_records WHERE expires_at <= now()",
    "DELETE FROM login_attempts WHERE created_at < now() - interval '90 days'",
    "DELETE FROM security_events WHERE created_at < now() - interval '180 days'",
  ];
  for (const statement of statements) await pool.query(statement);
}
