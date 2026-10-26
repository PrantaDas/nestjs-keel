import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import amqp, { type AmqpConnectionManager, type ChannelWrapper, type CreateChannelOpts } from 'amqp-connection-manager';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { RateGate } from '@/common/utils/rate-gate';
import { transportConfig } from '@/config/configuration';

/**
 * Topology names derived from RABBITMQ_EXCHANGE (`app.events`), so environments sharing a broker
 * (staging and preview, parallel test runs) never share a queue: like REDIS_KEY_PREFIX for Redis.
 */
export const topology = (exchange: string) => ({
  exchange,
  /** Dead letters of every consumer queue (rejected after their retries). */
  deadLetterExchange: `${exchange}.dlx`,
  rpcQueue: (service: string) => `${exchange}.rpc.${service}`,
});

/**
 * One AMQP connection per process, opened on first use and re-established on its own (heartbeats,
 * reconnect with backoff); channels re-run their setup after a reconnect, so exchanges, queues and
 * consumers come back by themselves. Without RABBITMQ_URL every use says "not set up".
 */
@Injectable()
export class RabbitMqConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private readonly errors = new RateGate(30_000);
  private manager?: AmqpConnectionManager;

  constructor(@Inject(transportConfig.KEY) readonly config: ConfigType<typeof transportConfig>) {}

  get configured(): boolean {
    return Boolean(this.config.rabbitmq.url);
  }

  channel(options: CreateChannelOpts): ChannelWrapper {
    const channel = this.connection().createChannel({ json: true, ...options });
    // A failing setup (e.g. a queue declared with other arguments) is logged, never an unhandled 'error'.
    channel.on('error', (err: Error, info: { name?: string }) => {
      const gate = this.errors.pass(`channel:${info?.name ?? options.name ?? ''}`);
      if (gate.pass) this.logger.error({ err, channel: info?.name ?? options.name }, 'RabbitMQ channel setup failed');
    });
    return channel;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.manager?.close().catch(() => undefined);
  }

  private connection(): AmqpConnectionManager {
    if (!this.configured) throw new IntegrationNotConfiguredException('RabbitMQ transport');
    if (!this.manager) {
      this.manager = amqp.connect([this.config.rabbitmq.url], {
        heartbeatIntervalInSeconds: 10,
        reconnectTimeInSeconds: 2,
        connectionOptions: { clientProperties: { connection_name: 'app' } },
      });
      this.manager.on('connect', () => this.logger.log('RabbitMQ connected'));
      this.manager.on('disconnect', ({ err }: { err?: Error }) => {
        const gate = this.errors.pass('disconnect');
        if (gate.pass) this.logger.warn({ err, suppressed: gate.suppressed }, 'RabbitMQ disconnected, reconnecting');
      });
    }
    return this.manager;
  }
}
