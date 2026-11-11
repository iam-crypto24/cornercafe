# Security remediation record

## Applied in this branch

| Finding | Change | Evidence |
| --- | --- | --- |
| Weak public reservation references | `crypto.randomBytes(16)` encoded as fixed-length Crockford Base32; database unique constraint; collision-safe insertion | API test checks the code format; code uses 128 random bits, no public sequential IDs. No collision was forced. |
| Public reservation disclosure | Lookup returns only `referenceNumber` and `status`; invalid and missing references share the same 404 body | Test verifies that name, visit, contact, table, and admin fields are absent. |
| Booking/lookup abuse | PostgreSQL-backed fixed-window limits, signed server-issued form-age token, honeypot, duplicate check, validation, 32 KB body cap, idempotency | Tests cover limits, valid signed flow, duplicates, malformed/oversized bodies, and idempotency. Multi-instance load was not simulated. |
| Origin/CSRF | Exact configured origin allowlist; unsafe requests reject missing/untrusted Origin; credentialed CORS only for allowlisted origins; HMAC CSRF on admin mutations; Secure/HttpOnly cookies | Tests cover missing/untrusted origins, missing CSRF, successful CSRF, and untrusted CORS. Real browser/custom-domain testing remains. |
| Guest data in browser storage | Removed localStorage reads/writes; preview is in-memory sample data and visible only during development | Source no longer stores or loads bookings in localStorage. Old browser profiles may retain stale data from the previous deployment. |
| Dates and overlap | Strict calendar dates, cafe timezone validation, table/capacity checks, transaction-based booking, PostgreSQL exclusion constraint | PGlite tests cover invalid date, overlap, transaction rollback, and migration. Real Postgres concurrency test is included but not run without a test database. |
| Authentication/authorization | Dummy scrypt for unknown accounts; legacy hash compatibility and upgrade; hashed 256-bit sessions; expiry; CSRF; owner/staff guards; password/deactivation revocation | Tests cover login, brute-force limit, protected routes, role checks, owner-only account creation with role forced to staff, logout, expiry, deactivation, and password change. |
| Blob as production DB | Removed Vercel serverless API handlers and `@vercel/blob` runtime dependency; added Render Express, PostgreSQL migrations, and guarded import/export | Frontend production build and PGlite backend suite pass. Production database unavailable. |
| Dependency audit | Removed vulnerable Blob dependency chain from runtime; regenerated lockfiles | `npm audit` root and backend both report zero vulnerabilities at audit time. Rerun after updates. |
| Secrets/logging | `.env*` ignored, dummy-only examples, no query/customer/cookie/raw-IP fields in structured logs, startup config validation, CI audit and Gitleaks workflow | Source/config review; GitHub workflow has not yet run from this branch. |

## Migration safeguards

The importer refuses unsupported state/hash formats, nonempty destinations, and changed repeat imports. It preserves compatible scrypt hashes (upgraded at next login), reissues old references, writes an ignored local reference map, invalidates old sessions, and never deletes or overwrites the Blob source.

Pause bookings during cutover. Old public references will stop working, and the app does not email replacement references; use the map privately to notify affected guests.

## Unresolved / deployment checks

- Add real Render/Vercel domains and environment values; test login/refresh/logout/status changes in a browser.
- Run `backend/tests/postgres-concurrency.test.js` against an isolated real PostgreSQL database before relying on concurrent-write behavior in production.
- Export/import only after the cafe pauses changes and verifies counts. No production credentials or Blob export were provided.
- Configure and test managed PostgreSQL backups and recovery before storing live customer data.
- CAPTCHA is not enabled. The signed form token, honeypot, rate limits, duplicate checks, and idempotency are active; enabling an external CAPTCHA secret requires implementing its frontend widget first.
- Previous browser versions may have written stale localStorage booking data. This version no longer reads/writes it; this code cannot remotely erase browser profiles.
- No external penetration test or real Render multi-instance test was performed.
