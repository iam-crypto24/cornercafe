import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const csrfTokenFor = (sessionTokenHash, secret) => createHmac('sha256', secret).update(sessionTokenHash).digest('base64url');

export function makeBookingFormToken(secret, now = Date.now()) {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString('base64url');
  const signature = createHmac('sha256', secret).update(`booking-form:${timestamp}:${nonce}`).digest('base64url');
  return `${timestamp}.${nonce}.${signature}`;
}

export function verifyBookingFormToken(token, secret, now = Date.now(), minAgeMs = 1_500, maxAgeMs = 30 * 60_000) {
  if (typeof token !== 'string' || token.length > 160) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
  const timestamp = Number(parts[0]);
  const age = now - timestamp;
  if (age < minAgeMs || age > maxAgeMs) return false;
  const expected = createHmac('sha256', secret).update(`booking-form:${parts[0]}:${parts[1]}`).digest('base64url');
  return safeEqual(parts[2], expected);
}

export function safeEqual(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function reservationReference() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let number = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let body = '';
  for (let index = 0; index < 26; index += 1) {
    body = alphabet[Number(number & 31n)] + body;
    number >>= 5n;
  }
  return `CC-${body}`;
}
