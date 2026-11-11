# Corner Cafe security audit

**Scope:** the Vite/React app, previous Vercel API and Blob implementation (reviewed before removing it), new Express/PostgreSQL API, migrations/import scripts, package manifests/locks, Vercel/Render configuration, docs, environment references, and reachable Git history.

**Branch:** `security/render-postgres-migration` (not committed/pushed, no PR opened).

**Production access:** none. The private Blob data, Vercel deployment, Render account, and real production database were not accessed or changed. No finding below claims a live exploit was demonstrated.

## Executive summary

The original app had short reservation references, a public status endpoint that returned guest and visit details, no public booking/lookup rate limits, permissive missing-Origin handling without CSRF tokens, browser persistence of admin booking PII, strict-date/timezone gaps, and a single JSON Blob document as its production store. The original package audit reported four high-severity findings in the Vercel Blob dependency chain.

The source now has a separate Render-ready Express API, PostgreSQL migrations and exclusion constraint, secure references and minimal lookup payloads, explicit CORS/Origin/CSRF, hashed sessions, role guards, distributed database rate limits, strict validation, idempotency, and a safe but unrun import path. Vercel API function source was removed. Root/backend dependency audits currently report zero vulnerabilities.

Build and embedded PostgreSQL-compatible integration tests pass. The test for simultaneous bookings against real PostgreSQL is included but skipped unless a dedicated `TEST_DATABASE_URL` is supplied. No live Render/Vercel browser flow, production import, or real PostgreSQL concurrent load has been verified. Do not cut over until the domain/cookie setup, real concurrency test, data import, and backup/recovery checks are complete.

## API endpoint inventory

| Method and path | Access | Behavior |
| --- | --- | --- |
| `GET /api/health` | Public | Database readiness, safe status only |
| `GET /api/availability` | Public, limited | Table or slot availability and signed booking-form token |
| `POST /api/reservations` | Public, exact Origin, limited | Validate and create idempotent pending booking |
| `GET /api/reservation-status?reference=` | Public, limited | Reference and status only |
| `GET /api/reservations/:reference` | Public alias, limited | Same minimal status lookup |
| `POST /api/admin/auth?action=login` | Public, exact Origin, rate-limited | Authenticate and set HttpOnly cookie |
| `GET /api/admin/auth?action=session` | Authenticated | Current admin identity and CSRF token |
| `POST /api/admin/auth/logout` | Authenticated, Origin + CSRF | Revoke session and clear cookie |
| `POST /api/admin/auth/password` | Authenticated, Origin + CSRF | Change password, revoke sessions |
| `GET /api/admin/reservations` | Staff or owner | Reservations including guest details |
| `PATCH /api/admin/reservation?id=` | Staff or owner, Origin + CSRF | Confirm or cancel |
| `PATCH /api/admin/reservations/:id` | Staff or owner alias | Same status operation |
| `GET /api/admin/tables` | Staff or owner | Seating and availability |
| `GET /api/admin/users` | Owner | List accounts without hashes |
| `POST /api/admin/users` | Owner, Origin + CSRF | Create staff account; role fixed server-side |
| `PATCH /api/admin/user?id=` | Owner, Origin + CSRF | Activate/deactivate staff; deactivation revokes sessions |
| `PATCH /api/admin/users/:id` | Owner alias | Same activation operation |

Unknown routes return safe JSON 404s. There is no public customer modification endpoint, password-reset endpoint, or email/SMS sender.

## Findings

“Verified by test” means a synthetic test ran against the code path. “Code verified” means the control is present in code but no exploit or production system was exercised.

| ID | Vulnerability / severity | Affected code | Technical issue and realistic scenario | Fix / recommendation | Verification |
| --- | --- | --- | --- | --- | --- |
| A-01 | Weak reservation reference entropy — **High, fixed** | Original `server/cafe-api.js createReservation`; current `backend/src/utils/security.js reservationReference` | Old references used five random bytes. A lookup attacker with enough attempts could try candidates and collisions were more likely. | New references use 16 random bytes and a 26-character unambiguous Base32 payload; a unique database constraint and collision retry protect storage. Internal row IDs are never public. | Format and insert path tested; actual collision was not forced. |
| A-02 | Public reservation data disclosure — **High, fixed** | Original public lookup in `server/cafe-api.js`; current `backend/src/app.js` and `repositories/reservations.js` | Old lookup returned name and visit/table details to any holder/guesser of a reference. | Lookup returns only public reference and status; invalid/missing codes return the same generic 404. No second factor is needed to reveal this minimal payload. | Test confirms no name/contact/date/party/table/admin fields in lookup payload. |
| A-03 | Public booking/lookup abuse — **High, addressed** | `backend/src/middleware/rate-limit.js`, `app.js`, `validators/reservations.js`, `repositories/reservations.js` | Automated requests could flood reservations/lookups or retry a booking after a lost response. | PostgreSQL atomic fixed-window rate limits by IP/contact, 32 KB JSON limit, validation/normalization, signed server-issued form-age token, honeypot, duplicate check, 24-hour idempotency, and optional configurable thresholds. No CAPTCHA integration is enabled. | Synthetic tests verify rate limit, malformed/oversized requests, duplicate, valid form token, and idempotent repeat. Multi-instance load and sophisticated bot resistance were not tested. |
| A-04 | Missing Origin accepted and no CSRF token — **Medium, fixed** | Original `verifySameOrigin`; current `backend/src/middleware/csrf.js`, `app.js` | A cross-site state-changing request could pass if Origin was missing; origin comparison was not an explicit frontend allowlist. | Exact `ALLOWED_ORIGINS`; reject missing/untrusted Origin on unsafe routes; credentialed CORS only reflects allowed origins; HMAC CSRF token for admin writes; Secure/HttpOnly host-only cookies. | Tests verify missing/untrusted origins, missing CSRF rejection, valid CSRF mutation, and untrusted CORS. Browser cross-domain cookies are not verified. |
| A-05 | Admin guest PII stored in localStorage — **Medium, fixed** | Original `src/App.tsx`; current `src/App.tsx` | Same-origin scripts or users of the browser profile could read cached guest names/contact/notes after sign-out. | Removed localStorage booking/table reads and writes. Preview data remains in-memory and is dev-only. | Source scan verified no app localStorage usage. Stale data in previous browser profiles is not remotely erased. |
| A-06 | Weak date validation/timezone handling — **Medium, fixed** | Original `parseDate`/booking handler; current `validators/reservations.js` | Normalized impossible dates or UTC day boundaries could allow past/invalid reservation times. | Round-trip calendar validation and required cafe IANA timezone for past-date/time checks. DB stores local date, time, and timezone. | Invalid calendar dates tested. Cafe-zone boundary cases were code-reviewed; DST/live-zone behavior was not tested in Render. |
| A-07 | Single JSON Blob store and booking races — **Medium, migrated in code** | Original Blob `mutateState`; current PostgreSQL migration and `repositories/reservations.js` | One document creates write contention and has no DB-level constraints/transactions. Two simultaneous writes could depend on retry logic. | Relational tables, foreign keys/checks/indexes, transaction, idempotency lock, and PostgreSQL exclusion constraint for active overlapping table ranges. | PGlite migration, rollback, and sequential constraint tests pass. Actual simultaneous request test is provided but skipped without a dedicated PostgreSQL test DB. |
| A-08 | Login limiter growth/provider-specific IP — **Medium, fixed in code** | Original Vercel-specific request-IP and login failure map; current distributed rate limiter/auth/maintenance | Changing login keys could grow one JSON document, and unknown-user timing differed. | Hashed IP/identity attempt records, database shared rate limits, trusted Render proxy hops, periodic expiry pruning, dummy scrypt for missing accounts, generic errors. | Brute-force limit and generic failure integration test passed. Timing distribution was not statistically measured. |
| A-09 | Incomplete input/body/error handling — **Low, fixed** | Original `parseBody`; current Express parser, validators, error middleware | Malformed/oversized JSON and unbounded fields could cause errors/resource use. | Strict 32 KB JSON parser, field bounds, allowlists, safe error IDs, generic server errors, query timeouts. | Malformed JSON 400 and oversized body 413 tested; injection-shaped table ID rejected. |
| A-10 | Dependency audit high findings — **High, fixed at current lockfiles** | Original root lock and `@vercel/blob` runtime dependency | npm audit originally returned four high issues in the Blob/transitive chain. | Removed Blob from deployed runtime, regenerated root/backend lockfiles, and added audit CI jobs. | Root `npm audit` and backend `npm audit` currently report zero vulnerabilities. Re-run on updates. |
| A-11 | Cross-site session cookie deployment — **Medium, deployment-dependent** | Render/Vercel custom-domain and `COOKIE_SAME_SITE` configuration | Default `vercel.app` frontend and `onrender.com` API are cross-site; browser third-party cookie policy can prevent staff login persistence. | Production guide requires same-site custom domains such as `www.<domain>` and `api.<domain>`, with Secure/Lax cookies and exact CORS origins. | Not verified because no deployment/domain access was provided. This blocks production auth cutover until browser-tested. |
| A-12 | Production data migration/backup not executed — **High, operationally unresolved** | `backend/scripts/import-legacy-state.js`, export tool, Render DB setup | Switching traffic without a final export/import or backup can omit new bookings or leave rollback data stale. | Importer is non-destructive, count-checking, repeat-safe for identical export; keep Blob intact, pause bookings during cutover, and configure/test paid PostgreSQL backup/restore. | Scripts reviewed; neither run against production. No live counts/backup verified. |
| A-13 | Bot challenge not enabled — **Low, residual** | Public reservation endpoint | A sufficiently adaptive bot can still solve/avoid basic honeypot and timing signals. | Current limits/contact caps/duplicate checks/idempotency reduce abuse. If stronger protection is needed, implement and test a CAPTCHA widget before setting a server CAPTCHA secret. | Rate protections tested; no bot campaign simulation. |

## Additional checks

- SQL uses parameterized `pg` queries. No NoSQL, shell command, dynamic HTML, or template execution is present. React renders untrusted strings as text; no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or `document.write` sink was found.
- Admin routes authenticate from a hashed session token; protected account routes independently enforce owner role. New users are always `staff`; frontend role input is ignored. IDs/roles from the client are never accepted as proof of access.
- Reservation data is server validated; prices are selected from the server catalog. Active overlapping intervals are constrained in PostgreSQL. Cancelled reservations cannot be restored via the API.
- Session tokens, password hashes, cookies, customer details, raw IPs, and query strings are excluded from request logs. Rate-limit keys and login identities are hashed in storage.
- The new backend uses `.env.example` placeholders only. A local `.env.local` existed at audit start, was ignored/untracked, and was intentionally not read. The prior history scan found no `.env*` path or common token/private-key assignment-pattern matches; this is not exhaustive. CI now includes Gitleaks but has not run on GitHub from this branch.
- No password-reset, email/SMS notification, automated restore job, or built-in admin audit-report UI exists. Database security/status events are stored but operational alert wiring is not configured.

## Verification summary

Final local verification: `npm ci` succeeded for both the frontend and backend; the frontend TypeScript/Vite production build passed; the backend suite reported **14 passed, 0 failed, 1 skipped**; root and backend `npm audit` each reported zero known vulnerabilities; `npm run lint` exited successfully with eight React hook/render warnings; and all backend JavaScript files passed `node --check`. The skipped case is the real-PostgreSQL concurrent double-booking test because `TEST_DATABASE_URL` was not provided. GitHub Actions has not run. No deployment, production data migration, browser-level CORS/cookie test, or external penetration test was performed.
