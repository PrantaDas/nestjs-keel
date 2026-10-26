import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import type { ConnectionOptions } from 'bullmq';
import { redisConfig, runtimeConfig } from '@/config/configuration';
import { parseRedisUrl } from '@/infra/redis/redis.util';
import { PolicyQueue, PolicyWorker, QueuePolicyApplier } from './policy-worker';
import { jobOptionsFor } from './queue-policies';

/** BullMQ connection on the core Redis (blocking commands need maxRetriesPerRequest: null). */
export const bullConnection = (config: ConfigType<typeof redisConfig>): ConnectionOptions =>
  parseRedisUrl(config.url, { maxRetriesPerRequest: null }) as ConnectionOptions;

/** Key prefix of every queue (environments and e2e runs sharing a Redis never mix). */
export const bullPrefix = (config: ConfigType<typeof redisConfig>): string => `${config.keyPrefix}bull`;

// Workers get their queue's policy (concurrency, limiter, stalled settings, metrics). Read by the
// explorer when processors are registered, i.e. after this module is loaded.
BullModule.workerClass = PolicyWorker;
// Producers fail fast during a core Redis outage (see PolicyQueue).
BullModule.queueClass = PolicyQueue;

/**
 * BullMQ root config on the core Redis (`noeviction` is required, or queued jobs can vanish).
 * Feature modules register their own queues with `BullModule.registerQueue({ name })`; every
 * queue's attempts / backoff / retention and worker settings come from `queue-policies.ts`.
 */
@Global()
@Module({
  imports: [
    DiscoveryModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY, runtimeConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>, runtime: ConfigType<typeof runtimeConfig>) => {
        PolicyQueue.producerCommandTimeoutMs = runtime.redis.commandTimeoutMs;
        return {
          connection: bullConnection(config),
          prefix: bullPrefix(config),
          // Fallback for a queue without a policy (each queue's own policy is applied at start).
          defaultJobOptions: jobOptionsFor(''),
        };
      },
    }),
  ],
  providers: [QueuePolicyApplier],
  exports: [BullModule],
})
export class QueueModule {}
