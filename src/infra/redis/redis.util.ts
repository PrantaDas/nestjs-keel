import type { RedisOptions } from 'ioredis';

/**
 * Turns `redis://user:pass@host:port/db` (or `rediss://` for TLS) into ioredis options,
 * so BullMQ, the socket adapter and plain clients all share one parsing rule.
 */
export function parseRedisUrl(url: string, overrides: RedisOptions = {}): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.replace('/', '');

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: db ? Number(db) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    ...overrides,
  };
}
