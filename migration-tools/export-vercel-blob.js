import { createHash } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import path from 'node:path';

const blobUrl = process.env.LEGACY_BLOB_URL;
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!blobUrl || !token) throw new Error('Set LEGACY_BLOB_URL and BLOB_READ_WRITE_TOKEN in your local shell before exporting.');

let parsedUrl;
try { parsedUrl = new URL(blobUrl); } catch { throw new Error('LEGACY_BLOB_URL must be an absolute HTTPS URL to the existing private state blob.'); }
if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.private.blob.vercel-storage.com')
  || !parsedUrl.pathname.endsWith('/corner-cafe/state-v1.json') || parsedUrl.username || parsedUrl.password) {
  throw new Error('LEGACY_BLOB_URL must point to the existing private corner-cafe/state-v1.json blob.');
}

const response = await fetch(parsedUrl, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
  cache: 'no-store',
});
if (!response.ok) throw new Error(`Legacy blob export failed with HTTP ${response.status}. Check the blob URL and token.`);
const reader = response.body?.getReader();
if (!reader) throw new Error('Legacy blob response did not contain a readable file.');
const chunks = [];
let totalBytes = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  totalBytes += value.byteLength;
  if (totalBytes > 10 * 1024 * 1024) {
    await reader.cancel();
    throw new Error('Legacy state exceeds the 10 MB migration safety limit. Use a reviewed manual transfer process.');
  }
  chunks.push(Buffer.from(value));
}

const contents = Buffer.concat(chunks);
let state;
try { state = JSON.parse(contents.toString('utf8')); } catch { throw new Error('Legacy blob did not contain valid JSON.'); }
if (!state || state.version !== 1 || !Array.isArray(state.admins) || !Array.isArray(state.bookings) || !Array.isArray(state.tables)) {
  throw new Error('Legacy state has an unsupported structure; no export file was written.');
}

const digest = createHash('sha256').update(contents).digest('hex');
const destination = path.resolve(process.cwd(), 'corner-cafe.legacy-state.json');
const temporary = `${destination}.partial`;
let handle;
try {
  handle = await open(temporary, 'wx', 0o600);
  await handle.writeFile(contents);
  await handle.sync();
  await handle.close();
  handle = null;
  await rename(temporary, destination);
} catch (error) {
  if (handle) await handle.close().catch(() => {});
  throw new Error(`Could not safely create the local export file (${error.code || 'FILE_ERROR'}).`);
}

console.log(JSON.stringify({
  event: 'legacy_export_complete', output: path.basename(destination),
  sha256: digest, bytes: totalBytes, tables: state.tables.length,
  reservations: state.bookings.length, adminAccounts: state.admins.length,
}));
