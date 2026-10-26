import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { DomainEvent } from '@/common/events/domain-event';
import { EventBus } from '@/infra/events/event-bus';
import { RabbitMqConnection, topology } from './rabbitmq.connection';

/** Redeliveries (with the attempt count in a header) before a message goes to the dead-letter queue. */
const MAX_DELIVERIES = 3;

/**
 * For a service extracted from the monolith: consumes the events it cares about from the topic
 * exchange into its own durable queue and runs its `@OnDomainEvent` handlers, exactly as the outbox
 * relay does in-process. Manual ack after the handlers succeed; a failing message is retried up to 3
 * times, then dead-lettered to `<queue>.dlq` for inspection.
 */
@Injectable()
export class RabbitMqEventConsumer implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqEventConsumer.name);
  private channel?: ChannelWrapper;

  constructor(
    private readonly connection: RabbitMqConnection,
    private readonly bus: EventBus,
  ) {}

  /** `queue` is this service's (durable); `patterns` are routing keys such as `user.*`. */
  start(queue: string, patterns: readonly string[]): ChannelWrapper {
    const names = topology(this.connection.config.rabbitmq.exchange);
    this.channel = this.connection.channel({
      name: `consumer:${queue}`,
      confirm: false,
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(names.exchange, 'topic', { durable: true });
        await channel.assertExchange(names.deadLetterExchange, 'topic', { durable: true });
        await channel.assertQueue(`${queue}.dlq`, { durable: true });
        await channel.bindQueue(`${queue}.dlq`, names.deadLetterExchange, '#');
        await channel.assertQueue(queue, { durable: true, deadLetterExchange: names.deadLetterExchange });
        for (const pattern of patterns) await channel.bindQueue(queue, names.exchange, pattern);
        await channel.prefetch(this.connection.config.rabbitmq.prefetch);
        await channel.consume(queue, (message) => void this.handle(channel, queue, message), { noAck: false });
      },
    });
    return this.channel;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
  }

  private async handle(channel: ConfirmChannel, queue: string, message: ConsumeMessage | null): Promise<void> {
    if (!message) return;
    try {
      const event = JSON.parse(message.content.toString('utf8')) as DomainEvent & { occurredAt: string };
      await this.bus.dispatch({ ...event, occurredAt: new Date(event.occurredAt) });
      channel.ack(message);
    } catch (error) {
      const deliveries = Number((message.properties.headers ?? {})['x-deliveries'] ?? 1);
      if (deliveries < MAX_DELIVERIES) {
        // Back on the queue with a count; acked so the broker does not redeliver it immediately as well.
        channel.sendToQueue(queue, message.content, {
          ...message.properties,
          headers: { ...message.properties.headers, 'x-deliveries': deliveries + 1 },
        });
        channel.ack(message);
      } else {
        this.logger.error(
          { err: error, queue, messageId: message.properties.messageId as string },
          'Event dead-lettered after retries',
        );
        channel.nack(message, false, false);
      }
    }
  }
}
