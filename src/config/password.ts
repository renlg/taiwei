import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_KEY_LENGTH = 64;

export function isScryptPassword(value: string): boolean {
  const parts = value.split('$');
  return parts.length === 3
    && parts[0] === SCRYPT_PREFIX
    && /^[a-f0-9]{32}$/i.test(parts[1] ?? '')
    && /^[a-f0-9]{128}$/i.test(parts[2] ?? '');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `${SCRYPT_PREFIX}$${salt}$${hash}`;
}

export function passwordForStorage(password: string): string {
  return !password || isScryptPassword(password) ? password : hashPassword(password);
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isScryptPassword(stored)) return password === stored;
  const [, salt, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex!, 'hex');
  const actual = scryptSync(password, salt!, expected.length);
  return timingSafeEqual(actual, expected);
}
