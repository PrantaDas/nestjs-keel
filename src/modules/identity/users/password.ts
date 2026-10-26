import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt (memory-hard, built into Node, runs on the libuv thread pool so it never blocks the event
 * loop). Parameters follow the OWASP password storage cheat sheet: N=2^15, r=8, p=3 (≈32 MiB per
 * hash). They are stored with each hash, so raising them later only needs `needsRehash` on login.
 */
const PARAMS = { logN: 15, r: 8, p: 3 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 128 * 1024 * 1024;

const encode = (logN: number, r: number, p: number, salt: Buffer, hash: Buffer) =>
  `scrypt$${logN}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: 2 ** PARAMS.logN,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEMORY,
  });
  return encode(PARAMS.logN, PARAMS.r, PARAMS.p, salt, hash);
}

/** Constant-time check; false for anything malformed. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = stored?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltText, 'base64url'), expected.length, {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash uses older parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const [, logN, r, p] = stored.split('$');
  return Number(logN) !== PARAMS.logN || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p;
}

/**
 * A real hash of a random password, computed once: verifying against it when the account does not
 * exist makes "no such account" take as long as "wrong password" (no account discovery by timing).
 */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}
