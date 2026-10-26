import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { isRetryable } from '@/infra/queue/base.processor';
import { RPC_METHOD, RpcMethodMetadata } from '../rpc-method.decorator';
import type { RpcReply } from './rabbitmq.transport';
import { RabbitMqConnection, topology } from './rabbitmq.connection';

type Handler = (payload: unknown) => unknown;

/**
 * Serves `@RpcMethod` handlers over RabbitMQ: one durable `rpc.<service>` queue per service, manual
 * acks, a prefetch limit. A handler error is an answer (`ok: false`), acked like a success: the
 * caller decides; a malformed request is rejected to the dead-letter exchange.
 */
@Injectable()
export class RabbitMqRpcServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqRpcServer.name);
  private readonly handlers = new Map<string, Map<string, Handler>>();
  private channel?: ChannelWrapper;

  constructor(
    private readonly connection: RabbitMqConnection,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of [...this.discovery.getProviders(), ...this.discovery.getControllers()]) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      for (const name of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance) as object)) {
        const method = instance[name] as Handler;
        const meta = this.reflector.get<RpcMethodMetadata | undefined>(RPC_METHOD, method);
        if (!meta) continue;
        const methods = this.handlers.get(meta.service) ?? new Map<string, Handler>();
        methods.set(meta.method, method.bind(instance));
        this.handlers.set(meta.service, methods);
      }
    }
    if (!this.handlers.size || !this.connection.configured) return;
    const names = topology(this.connection.config.rabbitmq.exchange);
    this.channel = this.connection.channel({
      name: 'rpc-server',
      confirm: false,
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(names.deadLetterExchange, 'topic', { durable: true });
        await channel.prefetch(this.connection.config.rabbitmq.prefetch);
        for (const service of this.handlers.keys()) {
          const queue = names.rpcQueue(service);
          await channel.assertQueue(queue, { durable: true, deadLetterExchange: names.deadLetterExchange });
          await channel.consume(queue, (message) => void this.serve(channel, service, message), { noAck: false });
        }
      },
    });
    this.logger.log({ services: [...this.handlers.keys()] }, 'RabbitMQ RPC server started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
  }

  private async serve(channel: ConfirmChannel, service: string, message: ConsumeMessage | null): Promise<void> {
    if (!message) return;
    let request: { method?: string; payload?: unknown };
    try {
      request = JSON.parse(message.content.toString('utf8')) as { method?: string; payload?: unknown };
    } catch {
      channel.nack(message, false, false);
      return;
    }
    const handler = request.method ? this.handlers.get(service)?.get(request.method) : undefined;
    let reply: RpcReply;
    if (!handler) {
      reply = { ok: false, error: { detail: `unknown method ${request.method}`, transient: false } };
    } else {
      try {
        reply = { ok: true, result: await handler(request.payload) };
      } catch (error) {
        this.logger.warn({ err: error, service, method: request.method }, 'RPC handler failed');
        reply = {
          ok: false,
          error: { detail: error instanceof Error ? error.message : 'error', transient: isRetryable(error) },
        };
      }
    }
    const { replyTo, correlationId } = message.properties as { replyTo?: string; correlationId?: string };
    if (replyTo) {
      channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(reply)), {
        correlationId,
        contentType: 'application/json',
      });
    }
    channel.ack(message);
  }
}
