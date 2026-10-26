import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { CacheService } from '@/infra/cache/cache.service';
import { RedisThrottlerStorage } from '@/infra/security/redis-throttler.storage';
import { closeRedis, createRedisClient, redisOptions, waitForReady } from './redis-client.factory';

const settings = { connectTimeoutMs: 400, commandTimeoutMs: 300, maxRetriesPerRequest: 2, cacheCommandTimeoutMs: 100 };
/** Nothing listens here, so connections are refused at once. */
const DEAD_URL = 'redis://127.0.0.1:1';

describe('redisOptions', () => {
  it('bounds core commands (timeout + retries) but lets them queue through short blips', () => {
    expect(redisOptions('core', settings)).toMatchObject({
      connectTimeout: 400,
      commandTimeout: 300,
      maxRetriesPerRequest: 2,
    });
    expect(redisOptions('core', settings).enableOfflineQueue).toBeUndefined();
  });

  it('never queues cache commands and gives them a short timeout', () => {
    expect(redisOptions('cache', settings)).toMatchObject({
      commandTimeout: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });

  it('keeps subscriptions queued until the reconnect (no timeout, no retry limit)', () => {
    const options = redisOptions('subscriber', settings);
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.commandTimeout).toBeUndefined();
  });
});

describe('Redis clients against an unreachable server', () => {
  let client: Redis;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await closeRedis(client);
    jest.restoreAllMocks();
  });
  // ioredis keeps a 500 ms timer after a hard disconnect of a socket that never opened.
  afterAll(() => new Promise((resolve) => setTimeout(resolve, 600)));

  it('fails a core command fast instead of hanging, and closes without hanging', async () => {
    client = createRedisClient('spec-core', DEAD_URL, redisOptions('core', settings));
    const started = performance.now();
    await expect(client.get('k')).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await waitForReady(client, 50)).toBe(false);
  });

  it('logs the outage once, not once per reconnect attempt', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    client = createRedisClient('spec-log', DEAD_URL, redisOptions('core', settings));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('turns cache failures into misses without trying while disconnected', async () => {
    client = createRedisClient('spec-cache', DEAD_URL, redisOptions('cache', settings));
    const cache = new CacheService(client, { keyPrefix: 't:', cacheDefaultTtlSeconds: 60 } as never);
    const get = jest.spyOn(client, 'get');
    await expect(cache.get('k')).resolves.toBeUndefined();
    await expect(cache.set('k', 1)).resolves.toBeUndefined();
    await expect(cache.wrap('k', () => Promise.resolve('loaded'))).resolves.toBe('loaded');
    expect(get).not.toHaveBeenCalled();
  });

  it('lets requests through when the rate limit storage is unreachable (fail open)', async () => {
    client = createRedisClient('spec-throttle', DEAD_URL, redisOptions('core', settings));
    const storage = new RedisThrottlerStorage(client, { keyPrefix: 't:' } as never);
    await expect(storage.increment('ip:1', 60_000, 1, 0, 'default')).resolves.toMatchObject({
      isBlocked: false,
      totalHits: 0,
    });
  });
});
