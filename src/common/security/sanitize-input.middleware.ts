import type { NextFunction, Request, Response } from 'express';

const MAX_DEPTH = 10;

/** Keys MongoDB would read as operators or paths: `$where`, `$gt`, `a.b`; plus prototype pollution. */
const isDangerousKey = (key: string): boolean =>
  key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype';

/**
 * Removes operator-like keys from user input at any depth, in place. DTO validation already
 * rejects unknown fields on typed bodies; this also covers query strings and free-form objects
 * (`Record<string, unknown>` fields, raw filters) that the whitelist cannot see.
 */
export function stripDangerousKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((item) => stripDangerousKeys(item, depth + 1));
    return value;
  }
  if (Buffer.isBuffer(value)) return value;
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) delete (value as Record<string, unknown>)[key];
    else stripDangerousKeys((value as Record<string, unknown>)[key], depth + 1);
  }
  return value;
}

/** Express middleware: sanitises `req.body` and `req.query` (Express 5's query is a getter: copied). */
export function sanitizeInputMiddleware(req: Request, _res: Response, next: NextFunction): void {
  stripDangerousKeys(req.body);
  const query = req.query as unknown;
  if (query && typeof query === 'object' && Object.keys(query).some(isDangerousKey)) {
    const clean = stripDangerousKeys({ ...(query as Record<string, unknown>) });
    Object.defineProperty(req, 'query', { value: clean, writable: true, configurable: true, enumerable: true });
  } else {
    stripDangerousKeys(query);
  }
  next();
}
