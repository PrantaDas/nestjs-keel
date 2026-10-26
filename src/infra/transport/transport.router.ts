import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { transportConfig } from '@/config/configuration';
import { GrpcTransport } from './grpc/grpc.transport';
import { MessageTransport } from './message-transport';
import { RabbitMqTransport } from './rabbitmq/rabbitmq.transport';

/** The transport a remote port uses, from TRANSPORT_ROUTES (`examples=grpc`). */
@Injectable()
export class TransportRouter {
  constructor(
    @Inject(transportConfig.KEY) private readonly config: ConfigType<typeof transportConfig>,
    private readonly grpc: GrpcTransport,
    private readonly rabbitmq: RabbitMqTransport,
  ) {}

  for(service: string): MessageTransport {
    const driver = this.config.routes[service];
    if (driver === 'grpc') return this.grpc;
    if (driver === 'rabbitmq') return this.rabbitmq;
    throw new Error(`[transport] "${service}" runs in-process (TRANSPORT_ROUTES): no remote transport`);
  }
}
