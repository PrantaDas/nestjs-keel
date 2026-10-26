import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { redisConfig } from '@/config/configuration';
import { RateGate } from '@/common/utils/rate-gate';
import { REDIS_CORE } from '@/infra/redis/redis.constants';

/**
 * Atomic fixed-window counter shared by all API instances.
 * KEYS: hits key, block key. ARGV: ttl ms, limit, block duration ms.
 * Returns: { hits, hitsTtlMs, blocked (0/1), blockTtlMs }.
 */
const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  return { tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('PTTL', KEYS[1]), 1, blockTtl }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local hitsTtl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  local blockMs = tonumber(ARGV[3])
  if blockMs > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', blockMs)
    return { hits, hitsTtl, 1, blockMs }
  end
  return { hits, hitsTtl, 1, hitsTtl }
end
return { hits, hitsTtl, 0, 0 }
`;

/**
 * The HTTP rate limit fails open: while the core Redis is unreachable or too slow, requests are
 * let through (logged at most every 30 s) instead of turning a Redis outage into a full API
 * outage. Business limits that guard money or abuse (OTP sends / verifications per phone, staff
 * failed logins) live in identity's own limiter, which fails closed (503).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly failureLogs = new RateGate(30_000);

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.config.keyPrefix}throttle:${throttlerName}:${key}`;
    let reply: [number, number, number, number];
    try {
      reply = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
    } catch (err) {
      const gate = this.failureLogs.pass('increment');
      if (gate.pass) {
        this.logger.warn({ err, suppressed: gate.suppressed }, 'Rate limit storage unavailable: requests let through');
      }
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }

    const [totalHits, hitsTtlMs, blocked, blockTtlMs] = reply;
    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(hitsTtlMs / 1000)),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.max(0, Math.ceil(blockTtlMs / 1000)),
    };
  }
}
