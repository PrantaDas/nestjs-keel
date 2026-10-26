import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { redisConfig } from '@/config/configuration';
import { bullPrefix } from '@/infra/queue/queue.module';
import { QueueName } from '@/infra/queue/queue.constants';
import { parseRedisUrl } from '@/infra/redis/redis.util';

/**
 * Read / admin handles on every BullMQ queue for the ops API, created lazily on ONE shared Redis
 * connection (the api process does not otherwise open one per queue). Commands fail fast when
 * Redis is down instead of hanging the request.
 */
@Injectable()
export class QueueInspector implements OnModuleDestroy {
  private readonly logger = new Logger(QueueInspector.name);
  private readonly queues = new Map<QueueName, Queue>();
  private connection?: Redis;

  constructor(@Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>) {}

  names(): QueueName[] {
    return Object.values(QueueName);
  }

  has(name: string): name is QueueName {
    return (this.names() as string[]).includes(name);
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.redis(), prefix: bullPrefix(this.config) });
      queue.on('error', (err) => this.logger.warn({ err, queue: name }, 'Ops queue handle error'));
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    await this.connection?.quit().catch(() => undefined);
  }

  private redis(): Redis {
    this.connection ??= new Redis({
      ...parseRedisUrl(this.config.url),
      connectionName: 'app:ops-queues',
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    return this.connection;
  }
}
