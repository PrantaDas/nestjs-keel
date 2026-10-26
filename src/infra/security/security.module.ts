import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { redisConfig, throttleConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Global rate limit backed by Redis. Tighten per route with
 * `@Throttle({ default: { limit: 5, ttl: 60_000 } })` (OTP, login, answer submission).
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [throttleConfig.KEY, redisConfig.KEY, REDIS_CORE],
      useFactory: (
        throttle: ConfigType<typeof throttleConfig>,
        redis: ConfigType<typeof redisConfig>,
        client: Redis,
      ) => ({
        throttlers: [{ name: 'default', ttl: throttle.ttlMs, limit: throttle.limit }],
        storage: new RedisThrottlerStorage(client, redis),
      }),
    }),
  ],
})
export class SecurityModule {}
