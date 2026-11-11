# Backend design

## Runtime and data

- `backend/src/server.js` validates production configuration, applies PostgreSQL migrations, starts Express on `0.0.0.0:$PORT`, and handles SIGTERM/SIGINT.
- `backend/src/app.js` defines the HTTP API, explicit CORS policy, request limits, rate limits, authentication, CSRF, and safe errors.
- `backend/src/services/auth.js` handles scrypt verification, hashed database sessions, owner/staff permissions, and revocation.
- `backend/src/repositories/reservations.js` contains parameterized SQL for availability, reservation creation, public status, staff listings, and transitions.
- `backend/src/database/migrations/` contains versioned PostgreSQL schema; migration checksums prevent changing an applied migration.
- `backend/src/data/catalog.json` is shared by the backend and TypeScript frontend for 27 tables, menu items, and time slots.

Production hosting is Vercel for the static React/Vite frontend, Render for the Node API, and Render PostgreSQL for persistent state. The frontend uses public `VITE_API_BASE_URL`; no backend handler remains under `api/`.

## API inventory

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Database readiness |
| `GET` | `/api/availability` | Public, limited | Seating and signed form-age token |
| `POST` | `/api/reservations` | Public, origin checked, limited | Idempotent reservation request |
| `GET` | `/api/reservation-status?reference=` | Public, limited | Reference and status only |
| `GET` | `/api/reservations/:reference` | Public alias, limited | Same status lookup |
| `POST` | `/api/admin/auth?action=login` | Public, origin checked, limited | Sign in and set HttpOnly cookie |
| `GET` | `/api/admin/auth?action=session` | Authenticated | Restore staff identity and CSRF token |
| `POST` | `/api/admin/auth/logout` | Authenticated, CSRF | Revoke session |
| `POST` | `/api/admin/auth/password` | Authenticated, CSRF | Change password and revoke sessions |
| `GET` | `/api/admin/reservations` | Staff or owner | List guest requests |
| `PATCH` | `/api/admin/reservation?id=` | Staff or owner, CSRF | Confirm or cancel request |
| `PATCH` | `/api/admin/reservations/:id` | Staff or owner, CSRF | Status alias |
| `GET` | `/api/admin/tables` | Staff or owner | Seating and availability |
| `GET`, `POST` | `/api/admin/users` | Owner (`POST` CSRF) | List or create staff accounts |
| `PATCH` | `/api/admin/user?id=` | Owner, CSRF | Deactivate/reactivate staff |
| `PATCH` | `/api/admin/users/:id` | Owner, CSRF | Account status alias |

There is no public customer edit/cancel route, password reset, or email/SMS integration.

## Data integrity

`reservations_no_table_overlap` is a PostgreSQL exclusion constraint on table ID and a generated 90-minute range. Reservation creation locks on idempotency key, verifies capacity and active seating, uses server-owned prices, and commits the booking, pre-order, status event, and idempotency response in one transaction. Cancellation frees the table; cancelled requests cannot be restored through the admin API.

See [DATABASE_MIGRATION.md](./DATABASE_MIGRATION.md) for the guarded one-time Blob transfer and rollback limits.
