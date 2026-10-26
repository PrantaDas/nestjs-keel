import { Global, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import { features } from '@/config/configuration';
import { EventBus, ExternalEventPublisher } from '@/infra/events/event-bus';
import { NotesStatsClient } from './clients/notes-stats.client';
import { GrpcTransport } from './grpc/grpc.transport';
import { RabbitMqEventConsumer } from './rabbitmq/rabbitmq-event.consumer';
import { RabbitMqEventPublisher } from './rabbitmq/rabbitmq-event.publisher';
import { RabbitMqRpcServer } from './rabbitmq/rabbitmq-rpc.server';
import { RabbitMqConnection } from './rabbitmq/rabbitmq.connection';
import { RabbitMqTransport } from './rabbitmq/rabbitmq.transport';
import { TransportRouter } from './transport.router';

/**
 * Remote clients of ports, bound only for the ports TRANSPORT_ROUTES sends over the wire; the
 * owning module binds the in-process implementation otherwise. Add one line per extracted port.
 */
const remotePorts: Provider[] = [
  ...(features.transportRoute('examples') !== 'inprocess' ? [{ provide: NotesStats, useClass: NotesStatsClient }] : []),
];

/**
 * Inter-service transport for every process (part of CoreModule): the gRPC and RabbitMQ clients,
 * the router that picks one per service, remote port clients, and the outbox's external publisher
 * when EVENTS_EXTERNAL=rabbitmq. Nothing connects until first used.
 */
@Global()
@Module({
  providers: [
    RabbitMqConnection,
    GrpcTransport,
    RabbitMqTransport,
    TransportRouter,
    ...remotePorts,
    ...(features.externalEvents() ? [{ provide: ExternalEventPublisher, useClass: RabbitMqEventPublisher }] : []),
  ],
  exports: [
    RabbitMqConnection,
    GrpcTransport,
    RabbitMqTransport,
    TransportRouter,
    ...remotePorts.map((provider) => (provider as { provide: unknown }).provide as typeof NotesStats),
    ...(features.externalEvents() ? [ExternalEventPublisher] : []),
  ],
})
export class TransportModule {}

/** Serving side (worker): answers `@RpcMethod` handlers over RabbitMQ when it is configured. */
@Module({
  imports: [DiscoveryModule],
  providers: [RabbitMqRpcServer],
})
export class RabbitMqServerModule {}

/** For extracted services: consume domain events from RabbitMQ into local `@OnDomainEvent` handlers. */
@Module({
  imports: [DiscoveryModule],
  providers: [EventBus, RabbitMqEventConsumer],
  exports: [RabbitMqEventConsumer],
})
export class RabbitMqConsumerModule {}
