import { Global, Inject, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig, runtimeConfig } from '@/config/configuration';
import { LockService } from './lock.service';
import { closeRedis, createRedisClient, redisOptions, waitForReady } from './redis-client.factory';
import { REDIS_CACHE, REDIS_CORE } from './redis.constants';

type Resilience = ConfigType<typeof runtimeConfig>;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CORE,
      inject: [redisConfig.KEY, runtimeConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>, resilience: Resilience) =>
        createRedisClient('core', config.url, redisOptions('core', resilience.redis)),
    },
    {
      // Optional: without REDIS_CACHE_URL there is no cache client and every cache read is a miss.
      provide: REDIS_CACHE,
      inject: [redisConfig.KEY, runtimeConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>, resilience: Resilience): Redis | null =>
        config.cacheUrl ? createRedisClient('cache', config.cacheUrl, redisOptions('cache', resilience.redis)) : null,
    },
    LockService,
  ],
  exports: [REDIS_CORE, REDIS_CACHE, LockService],
})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(
    @Inject(REDIS_CORE) private readonly core: Redis,
    @Inject(REDIS_CACHE) private readonly cache: Redis | null,
    @Inject(runtimeConfig.KEY) private readonly resilience: Resilience,
  ) {}

  /**
   * Gives both clients up to the connect timeout before the app starts serving, so a normal boot
   * is warm. A Redis that is down does not stop the boot: the process starts degraded (readiness
   * reports it) and the client keeps reconnecting in the background.
   */
  async onModuleInit(): Promise<void> {
    const timeoutMs = this.resilience.redis.connectTimeoutMs;
    const [coreReady, cacheReady] = await Promise.all([
      waitForReady(this.core, timeoutMs),
      this.cache ? waitForReady(this.cache, timeoutMs) : Promise.resolve(true),
    ]);
    if (!coreReady) this.logger.warn('Core Redis unreachable at boot: starting degraded, reconnecting in background');
    if (!cacheReady) this.logger.warn('Cache Redis unreachable at boot: serving uncached, reconnecting in background');
    if (!this.cache) this.logger.log('No cache Redis configured (REDIS_CACHE_URL): every cache read is a miss');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([closeRedis(this.core), this.cache && closeRedis(this.cache)]);
  }
}
