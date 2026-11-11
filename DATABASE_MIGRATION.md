# Vercel Blob to PostgreSQL migration

## Safety status

The export and guarded importer are implemented, but neither has been run. This workspace has no Vercel Blob token, production database, or production access. No reservation/admin data has been read, overwritten, deleted, or transferred. The Blob source stays untouched.

## What migrates

- Tables/layout; the migration also seeds the 27-table catalog.
- Admin names, email, role, active status, UUID-compatible IDs, and compatible `scrypt$16384$...` password hashes. Hashes upgrade on the next successful login.
- Reservations, date/time, party size, table, guest contact, notes, status, creation time, mapped reviewer/time, and historical pre-order snapshots/prices.
- New high-entropy reservation references. Old references are private-only in `legacy_reference` and in a local ignored reference map for guest notification.

Old sessions are invalidated. The importer refuses unsupported state/password formats, invalid/overlapping reservations, nonempty destinations, and changed repeat imports. Failed writes roll back. It does not delete or alter the Blob source.

## Cutover procedure

1. Schedule a low-traffic cutover and pause new bookings/status edits in the old app. Any activity after export would otherwise be missed.
2. Take a provider backup/export of the private Blob and retain the original source.
3. Create Render PostgreSQL and complete the initial schema migration. Confirm no reservation/admin rows exist.
4. Temporarily allowlist only your current IP for external DB access. Use Render’s external connection URL only for the one-time import; remove the IP entry afterward. Do not allow `0.0.0.0/0`.
5. Export the private Blob file locally. The script uses Vercel’s authenticated private-Blob fetch, allows only an HTTPS `*.private.blob.vercel-storage.com` URL ending in `/corner-cafe/state-v1.json`, limits it to 10 MB, and writes a local file. [Vercel private Blob access](https://vercel.com/docs/vercel-blob/private-storage)

   PowerShell example; the token prompt is masked:

   ```powershell
   $env:LEGACY_BLOB_URL = Read-Host "Private state blob URL"
   $secureToken = Read-Host "Vercel Blob token" -AsSecureString
   $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
   try { $env:BLOB_READ_WRITE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
   finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
   node .\migration-tools\export-vercel-blob.js
   Remove-Item Env:LEGACY_BLOB_URL
   Remove-Item Env:BLOB_READ_WRITE_TOKEN
   ```

   The ignored export is `migration-tools/corner-cafe.legacy-state.json`. Do not share or commit it.

6. Put Render’s external connection URL in ignored `backend/.env` as `DATABASE_URL`, use the correct `CAFE_TIME_ZONE`, then run:

   ```powershell
   npm.cmd --prefix backend run db:import-legacy -- ../migration-tools/corner-cafe.legacy-state.json
   ```

   Import logs contain a file hash/counts, not customer rows or secrets. The importer checks target counts within the transaction. It writes `migration-tools/corner-cafe.reference-map.json` (old/new refs only); keep it protected and privately send replacement refs to guests. The app does not email them.

7. Verify counts and representative fields in the staff dashboard. Confirm an active owner can sign in. Keep booking traffic paused until Vercel is configured for Render and smoke tests pass.
8. Remove the temporary database IP allowlist and clear `DATABASE_URL`, `LEGACY_BLOB_URL`, and `BLOB_READ_WRITE_TOKEN` from the local process. Retain source/export backups until database backup and recovery are verified.

## Validation details and limits

- Expected Blob state version is `1`, with `admins`, `bookings`, and `tables` arrays.
- Invalid dates, slots, party sizes, contacts, tables, roles, hashes, statuses, duplicate IDs/items, oversized text, or overlapping active bookings stop import instead of silently dropping records.
- Unknown historical menu items are inserted inactive so historical preorder foreign keys and price/name snapshots remain valid.
- Invalid/missing reviewer IDs become null; compatible reviewer IDs/timestamps are preserved.
- All old public references are reissued. The old code will not work for public lookup after migration. Process the mapping before deleting the local export.
- A different export after a successful import is refused. Do not edit `data_imports` to force a rerun.
- Real concurrent insertion was not validated in this environment. A dedicated real-PostgreSQL test is available as `backend/tests/postgres-concurrency.test.js`.

## Backup and rollback

Before cutover, retain the Vercel Blob source and configure provider-managed backups on the paid Render PostgreSQL plan. Verify a restore to a separate database.

If reverting, reconcile any PostgreSQL bookings made after cutover with the frozen Blob snapshot before switching traffic to old code. The old Blob does not receive new PostgreSQL writes. No reverse importer is included because automatic merging could duplicate or overwrite reservations. Do not switch back blindly.
