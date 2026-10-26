const MAX_DEPTH = 5;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;

/** Key words that mark a secret on their own (`otp`, `refreshToken`, `smtp.pass`, `x-api-key`…). */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'passphrase',
  'passcode',
  'pwd',
  'otp',
  'totp',
  'pin',
  'cvv',
  'cvc',
  'token',
  'secret',
  'credential',
  'authorization',
  'cookie',
  // Single-word spellings of the pairs below (`authkey` header, `apikey` params).
  'apikey',
  'authkey',
  'accesskey',
  'secretkey',
  'privatekey',
]);

/** `<qualifier> key` pairs that are secrets (`authKey`, `api_key`, `privateKey`); a bare `key` is not. */
const KEY_QUALIFIERS = new Set(['api', 'auth', 'access', 'secret', 'private', 'encryption', 'signing', 'master']);

/**
 * Splits a key into lower-case words: camelCase / PascalCase, snake_case, kebab-case, dots and
 * spaces (`X-Api-Key` → x, api, key; `APIKey` → api, key; `appInReview` → app, in, review).
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

const isSecretWord = (word: string): boolean =>
  SECRET_WORDS.has(word) || (word.length > 3 && word.endsWith('s') && SECRET_WORDS.has(word.slice(0, -1)));

/**
 * True when a field name denotes a secret. Matches whole words of the key, never substrings, so
 * `appInReview`, `passage`, `spinner` or `imageKey` stay readable while `authKey`, `apiKey`,
 * `refresh_token`, `x-api-key` and `newPassword` are redacted.
 */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  return words.some((word, i) => isSecretWord(word) || (word === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1])));
}

/**
 * Copy of `value` that is safe to persist in logs/audit: secrets redacted, long strings
 * truncated, deep or huge structures cut off. A secret field that is null/undefined stays visible
 * (it carries no secret and shows that a credential was cleared).
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return '[max depth]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitizeForLog(item, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `…[${value.length - MAX_ARRAY} more]`] : items;
  }

  // ObjectId and similar: keep their string form.
  const hex = (value as { toHexString?: () => string }).toHexString;
  if (typeof hex === 'function') return hex.call(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      isSensitiveKey(key) && v !== null && v !== undefined ? '[redacted]' : sanitizeForLog(v, depth + 1),
    ]),
  );
}
