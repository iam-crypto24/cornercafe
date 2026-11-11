import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const COST = 32_768;
const PARAMETERS = { N: COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function makePassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, PARAMETERS);
  return `scrypt$${COST}$${salt.toString('hex')}$${Buffer.from(key).toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, costText, saltHex, keyHex] = String(storedHash || '').split('$');
  const cost = Number(costText);
  if (algorithm !== 'scrypt' || ![16_384, 32_768].includes(cost)
    || !/^[a-f0-9]{32}$/i.test(saltHex || '') || !/^[a-f0-9]{128}$/i.test(keyHex || '')) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = Buffer.from(await scryptAsync(password, salt, KEY_LENGTH, { ...PARAMETERS, N: cost }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const DUMMY_PASSWORD_HASH = makePassword(randomBytes(32).toString('base64url'));
