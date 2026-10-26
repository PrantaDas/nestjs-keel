import { Injectable, Logger } from '@nestjs/common';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { IntegrationCallException } from '@/integrations/resilience/failure';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { MessageTransport, PublishOptions, RequestOptions, RpcCall } from '../message-transport';
import { RabbitMqConnection, topology } from './rabbitmq.connection';

const DIRECT_REPLY = 'amq.rabbitmq.reply-to';

/** What an RPC server answers: the result, or an error that was an answer (not an outage). */
export interface RpcReply {
  ok: boolean;
  result?: unknown;
  /** Internal (service to service): never shown to a person. */
  error?: { detail: string; transient: boolean };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * RabbitMQ side of `MessageTransport`:
 * - `publish`: durable topic exchange, persistent messages, publisher confirms (the promise resolves
 *   once the broker took responsibility), message id = event id;
 * - `request`: RPC on the durable `rpc.<service>` queue with direct reply-to and a deadline; never
 *   retried (a request may have been processed even if its reply was lost: ambiguous).
 */
@Injectable()
export class RabbitMqTransport extends MessageTransport {
  readonly driver = 'rabbitmq' as const;
  private readonly logger = new Logger(RabbitMqTransport.name);
  private readonly pending = new Map<string, Pending>();
  private publisher?: ChannelWrapper;
  private rpc?: ChannelWrapper;

  constructor(private readonly connection: RabbitMqConnection) {
    super();
  }

  async publish(topic: string, message: object, options: PublishOptions = {}): Promise<void> {
    const channel = this.publishChannel();
    await guardedCall('RabbitMQ transport', () =>
      channel.publish(topology(this.connection.config.rabbitmq.exchange).exchange, topic, message, {
        persistent: true,
        contentType: 'application/json',
        messageId: options.messageId,
        headers: options.headers,
        timeout: 10_000,
      }),
    );
  }

  async request<TResponse, TPayload = unknown>(
    call: RpcCall<TPayload>,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const timeoutMs = options.timeoutMs ?? this.connection.config.grpc.deadlineMs;
    const channel = this.rpcChannel();
    const integration = `RabbitMQ ${call.service}`;
    return guardedCall(integration, async () => {
      await channel.waitForConnect();
      const correlationId = randomUUID();
      const reply = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(correlationId);
          reject(new IntegrationCallException(integration, { transient: true, ambiguous: true, reason: 'timeout' }));
        }, timeoutMs);
        timer.unref();
        this.pending.set(correlationId, { resolve, reject, timer });
      });
      await channel.sendToQueue(
        topology(this.connection.config.rabbitmq.exchange).rpcQueue(call.service),
        { method: call.method, payload: call.payload },
        {
          correlationId,
          replyTo: DIRECT_REPLY,
          expiration: String(timeoutMs),
          contentType: 'application/json',
        },
      );
      const answer = (await reply) as RpcReply;
      if (!answer.ok) {
        throw new IntegrationCallException(
          integration,
          { transient: answer.error?.transient ?? false, ambiguous: false, reason: 'remote_error' },
          new Error(answer.error?.detail ?? 'remote error'),
        );
      }
      return answer.result as TResponse;
    });
  }

  private publishChannel(): ChannelWrapper {
    this.publisher ??= this.connection.channel({
      name: 'publisher',
      confirm: true,
      setup: async (channel: ConfirmChannel) => {
        const names = topology(this.connection.config.rabbitmq.exchange);
        await channel.assertExchange(names.exchange, 'topic', { durable: true });
        await channel.assertExchange(names.deadLetterExchange, 'topic', { durable: true });
      },
    });
    return this.publisher;
  }

  /** Direct reply-to: replies arrive on this channel, matched by correlation id. */
  private rpcChannel(): ChannelWrapper {
    this.rpc ??= this.connection.channel({
      name: 'rpc-client',
      confirm: false,
      setup: async (channel: ConfirmChannel) => {
        await channel.consume(DIRECT_REPLY, (message) => this.onReply(message), { noAck: true });
      },
    });
    return this.rpc;
  }

  private onReply(message: ConsumeMessage | null): void {
    if (!message) return;
    const pending = this.pending.get(message.properties.correlationId as string);
    if (!pending) {
      this.logger.debug({ correlationId: message.properties.correlationId as string }, 'Late RPC reply dropped');
      return;
    }
    this.pending.delete(message.properties.correlationId as string);
    clearTimeout(pending.timer);
    try {
      pending.resolve(JSON.parse(message.content.toString('utf8')));
    } catch (error) {
      pending.reject(error);
    }
  }
}
