import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';
import { redisConfig, runtimeConfig } from '@/config/configuration';
import { closeRedis, redisOptions } from '@/infra/redis/redis-client.factory';
import { parseRedisUrl } from '@/infra/redis/redis.util';

/**
 * Pub/sub for GraphQL subscriptions over the core Redis, so an event published by any process (the
 * api writing a note, a worker) reaches the subscribers connected to any graphql instance. Clients
 * connect lazily: a process that only publishes never opens the subscriber connection.
 */
@Injectable()
export class GraphqlPubSub implements OnApplicationShutdown {
  private pubsub?: RedisPubSub;
  private clients: Redis[] = [];

  constructor(
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    @Inject(runtimeConfig.KEY) private readonly runtime: ConfigType<typeof runtimeConfig>,
  ) {}

  /** Channel names are prefixed like every other key, so environments sharing a Redis never mix. */
  channel(name: string): string {
    return `${this.config.keyPrefix}gql:${name}`;
  }

  async publish(name: string, payload: unknown): Promise<void> {
    await this.engine().publish(this.channel(name), payload);
  }

  asyncIterator<T>(name: string): AsyncIterator<T> {
    return this.engine().asyncIterator<T>(this.channel(name));
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => closeRedis(client)));
  }

  private engine(): RedisPubSub {
    if (!this.pubsub) {
      const publisher = new Redis({
        ...parseRedisUrl(this.config.url),
        ...redisOptions('publisher', this.runtime.redis),
        lazyConnect: true,
      });
      const subscriber = new Redis({
        ...parseRedisUrl(this.config.url),
        ...redisOptions('subscriber', this.runtime.redis),
        lazyConnect: true,
      });
      this.clients = [publisher, subscriber];
      // graphql-redis-subscriptions is typed against ioredis 5; the client API it uses is unchanged in 6.
      this.pubsub = new RedisPubSub({ publisher: publisher as never, subscriber: subscriber as never });
    }
    return this.pubsub;
  }
}

/**
 * Publishing is needed by every process that changes data (api, worker), so this is part of
 * CoreModule; the GraphQL server itself is only in the graphql process (`GraphqlServerModule`).
 */
@Global()
@Module({ providers: [GraphqlPubSub], exports: [GraphqlPubSub] })
export class GraphqlPubSubModule {}
