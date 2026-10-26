import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import type { runtimeConfig } from '@/config/configuration';
import { parseRedisUrl } from './redis.util';

export type RedisSettings = ConfigType<typeof runtimeConfig>['redis'];

/**
 * How a client behaves while its Redis is unreachable (docs/architecture/fault-tolerance.md):
 * - `core`: commands wait in the offline queue (brief blips pass unnoticed) but fail after
 *   `commandTimeoutMs` or `maxRetriesPerRequest` reconnect attempts, so callers fail fast (503).
 * - `cache`: never queues; a command fails at once while disconnected or after
 *   `cacheCommandTimeoutMs`, and CacheService treats that as a miss.
 * - `subscriber` (socket adapter): subscriptions wait for the reconnect instead of being dropped;
 *   ioredis re-subscribes every channel once it is back.
 * - `publisher` (socket adapter / emitter): like `core`, a broadcast fails after the command timeout.
 */
export type RedisClientKind = 'core' | 'cache' | 'subscriber' | 'publisher';

export function redisOptions(kind: RedisClientKind, settings: RedisSettings): RedisOptions {
  // disconnectTimeout: a hard disconnect destroys a socket that does not close within this time.
  const base: RedisOptions = { connectTimeout: settings.connectTimeoutMs, disconnectTimeout: 500 };
  switch (kind) {
    case 'core':
      return {
        ...base,
        commandTimeout: settings.commandTimeoutMs,
        maxRetriesPerRequest: settings.maxRetriesPerRequest,
        enableAutoPipelining: true,
      };
    case 'cache':
      return {
        ...base,
        commandTimeout: settings.cacheCommandTimeoutMs,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        enableAutoPipelining: true,
      };
    case 'subscriber':
      return { ...base, maxRetriesPerRequest: null };
    case 'publisher':
      return {
        ...base,
        commandTimeout: settings.commandTimeoutMs,
        maxRetriesPerRequest: settings.maxRetriesPerRequest,
      };
  }
}

/** Repeated connection errors of one client are logged at most this often while it stays down. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * A client with outage-aware logging: the first connection error is logged at once, repeats once
 * every 30 s with a count, and the recovery is logged with the outage duration. ioredis keeps
 * reconnecting on its own (exponential backoff with jitter, capped at 5 s), so a returning Redis is
 * picked up without a restart.
 */
export function createRedisClient(name: string, url: string, options: RedisOptions): Redis {
  const logger = new Logger(`Redis:${name}`);
  const client = new Redis({ ...parseRedisUrl(url), connectionName: `app:${name}`, ...options });
  let downSince: number | undefined;
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;

  client.on('error', (err: Error) => {
    const now = performance.now();
    downSince ??= now;
    if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    logger.error({ err, suppressed, downForMs: Math.round(now - downSince) }, 'Redis connection error');
    lastLoggedAt = now;
    suppressed = 0;
  });
  client.on('ready', () => {
    if (downSince === undefined) {
      logger.log('Redis ready');
      return;
    }
    logger.log({ downForMs: Math.round(performance.now() - downSince) }, 'Redis connection restored');
    downSince = undefined;
    lastLoggedAt = Number.NEGATIVE_INFINITY;
    suppressed = 0;
  });
  client.on('close', () => {
    if (client.status !== 'end') downSince ??= performance.now();
  });
  return client;
}

/** Resolves true once the client is ready, false after `timeoutMs`. Never rejects. */
export function waitForReady(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ready: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ready);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    client.once('ready', onReady);
  });
}

/**
 * Closes a client without hanging on a dead server: QUIT when connected (pending replies arrive
 * first), bounded by `timeoutMs`, then a hard disconnect that also stops reconnect attempts.
 */
export async function closeRedis(client: Redis, timeoutMs = 1000): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'ready') {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.quit().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
  // QUIT may have ended the client meanwhile (TypeScript keeps the narrowing from the first check).
  if ((client.status as string) !== 'end') client.disconnect();
}
