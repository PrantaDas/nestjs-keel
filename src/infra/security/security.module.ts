import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { redisConfig, throttleConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';
import { DeprecationInterceptor } from './deprecation.interceptor';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { ThrottleLimits } from './throttle.decorators';

/**
 * HTTP protections of the api process: the Redis-backed rate limit (global default, tighter per
 * route with `@AuthThrottle()` / `@OtpThrottle()`), Idempotency-Key replay on unsafe routes and
 * deprecation headers on sunset routes.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [throttleConfig.KEY, redisConfig.KEY, REDIS_CORE],
      useFactory: (
        throttle: ConfigType<typeof throttleConfig>,
        redis: ConfigType<typeof redisConfig>,
        client: Redis,
      ) => {
        ThrottleLimits.auth = throttle.authLimit;
        ThrottleLimits.otp = throttle.otpLimit;
        return {
          throttlers: [{ name: 'default', ttl: throttle.ttlMs, limit: throttle.limit }],
          storage: new RedisThrottlerStorage(client, redis),
        };
      },
    }),
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class SecurityModule {}
