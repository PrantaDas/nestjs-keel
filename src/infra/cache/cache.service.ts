import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '@/config/configuration';
import { RateGate } from '@/common/utils/rate-gate';
import { REDIS_CACHE } from '@/infra/redis/redis.constants';

export interface CacheSetOptions {
  ttlSeconds?: number;
  /** Tags let one call invalidate a group of keys, e.g. `quiz:123`. */
  tags?: string[];
}

/**
 * JSON cache on the cache Redis. Every key has a TTL. The cache is optional (no REDIS_CACHE_URL:
 * every read is a miss, nothing is logged). When configured, failures are logged
 * (at most every 30 s per operation during an outage) and treated as a miss, and while the client
 * is disconnected no command is even attempted, so a cache outage slows the app down instead of
 * breaking it. Invalidations that fail during an outage leave entries to expire by their TTL.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failureLogs = new RateGate(30_000);

  constructor(
    @Inject(REDIS_CACHE) private readonly client: Redis | null,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  /** Narrowed by `available()`: only read after it returned true. */
  private get redis(): Redis {
    return this.client!;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.available('read')) return undefined;
    try {
      const raw = await this.redis.get(this.key(key));
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      this.failed('read', err, { key });
      return undefined;
    }
  }

  async set(key: string, value: unknown, options: CacheSetOptions = {}): Promise<void> {
    if (!this.available('write')) return;
    const ttl = options.ttlSeconds ?? this.config.cacheDefaultTtlSeconds;
    try {
      const pipeline = this.redis.multi().set(this.key(key), JSON.stringify(value), 'EX', ttl);
      for (const tag of options.tags ?? []) {
        // Tag sets outlive their keys slightly so invalidation never misses a live key.
        pipeline.sadd(this.tagKey(tag), this.key(key)).expire(this.tagKey(tag), ttl + 60);
      }
      await pipeline.exec();
    } catch (err) {
      this.failed('write', err, { key });
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0 || !this.available('delete')) return;
    await this.redis.del(...keys.map((k) => this.key(k))).catch((err: unknown) => this.failed('delete', err, { keys }));
  }

  async invalidateTag(tag: string): Promise<void> {
    if (!this.available('invalidate')) return;
    try {
      const keys = await this.redis.smembers(this.tagKey(tag));
      await this.redis.del(...keys, this.tagKey(tag));
    } catch (err) {
      this.failed('invalidate', err, { tag });
    }
  }

  /** False while the cache Redis is not connected: skip the call (a miss), log it now and then. */
  private available(operation: string): boolean {
    if (!this.client) return false;
    if (this.client.status === 'ready') return true;
    const gate = this.failureLogs.pass(`unavailable:${operation}`);
    if (gate.pass) {
      this.logger.warn(
        { operation, status: this.client.status, skipped: gate.suppressed },
        'Cache unavailable, skipped',
      );
    }
    return false;
  }

  private failed(operation: string, err: unknown, context: Record<string, unknown>): void {
    const gate = this.failureLogs.pass(`failed:${operation}`);
    if (gate.pass) this.logger.warn({ err, ...context, suppressed: gate.suppressed }, `Cache ${operation} failed`);
  }

  /**
   * Read-through cache. Concurrent misses for the same key in this process share one
   * loader call, which protects the database from stampedes on hot keys.
   */
  async wrap<T>(key: string, loader: () => Promise<T>, options: CacheSetOptions = {}): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const load = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) await this.set(key, value, options);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, load);
    return load;
  }

  private key(key: string): string {
    return `${this.config.keyPrefix}cache:${key}`;
  }

  private tagKey(tag: string): string {
    return `${this.config.keyPrefix}cache-tag:${tag}`;
  }
}
