import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { connect as amqpConnect } from 'amqplib';
import { Types } from 'mongoose';
import { CoreModule } from '@/app/core.module';
import { transportConfig } from '@/config/configuration';
import { IntegrationCallException } from '@/integrations/resilience/failure';
import { grpcServerOptions } from '@/infra/transport/grpc/grpc-server';
import { NotesStatsClient } from '@/infra/transport/clients/notes-stats.client';
import { GrpcTransport } from '@/infra/transport/grpc/grpc.transport';
import { TransportRouter } from '@/infra/transport/transport.router';
import { RabbitMqEventPublisher } from '@/infra/transport/rabbitmq/rabbitmq-event.publisher';
import { RabbitMqTransport } from '@/infra/transport/rabbitmq/rabbitmq.transport';
import { RabbitMqServerModule } from '@/infra/transport/transport.module';
import { PushSender } from '@/integrations/push/push.port';
import { NotesRpcModule } from '@/modules/examples/notes.module';
import { NotesService } from '@/modules/examples/notes.service';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';
import { defineEvent } from '@/common/events/domain-event';
import { FakePush } from './fakes';
import { resetState } from './helpers';

const RABBITMQ_URL = process.env.RABBITMQ_E2E_URL ?? 'amqp://guest:guest@localhost:5672';
const worker = Number(process.env.JEST_WORKER_ID ?? '1');
const GRPC_PORT = 50_600 + worker;
const EXCHANGE = `e2e.events.${process.pid}`;

/** The examples module serving its port, as an extracted service would (gRPC server + RabbitMQ RPC). */
@Module({ imports: [CoreModule, IdentityCoreModule, NotificationsCoreModule, NotesRpcModule, RabbitMqServerModule] })
class ServiceUnderTest {}

/**
 * The same port call over gRPC and over RabbitMQ RPC, with deadlines and classified failures; and
 * domain events published to the topic exchange with publisher confirms.
 */
describe('Transport: gRPC and RabbitMQ (e2e)', () => {
  let app: NestExpressApplication;
  let config: ReturnType<typeof transportConfig>;
  const owner = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    config = {
      ...transportConfig(),
      routes: { examples: 'grpc' },
      rabbitmq: { url: RABBITMQ_URL, exchange: EXCHANGE, prefetch: 10 },
      grpc: { examplesUrl: `127.0.0.1:${GRPC_PORT}`, deadlineMs: 2000 },
    };
    const moduleRef = await Test.createTestingModule({ imports: [ServiceUnderTest] })
      .overrideProvider(transportConfig.KEY)
      .useValue(config)
      .overrideProvider(PushSender)
      .useValue(new FakePush())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
    app.connectMicroservice(grpcServerOptions(GRPC_PORT));
    await app.startAllMicroservices();
    await app.init();
    await resetState(app);
    const notes = app.get(NotesService);
    await notes.create(owner, { title: 'One' });
    await notes.create(owner, { title: 'Two' });
  });

  afterAll(async () => {
    await resetState(app);
    await app.close();
    // Durable topology of this run only (the names carry the process id).
    const connection = await amqpConnect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    await channel.deleteQueue(`${EXCHANGE}.rpc.examples`);
    await channel.deleteExchange(EXCHANGE);
    await channel.deleteExchange(`${EXCHANGE}.dlx`);
    await connection.close();
  });

  const call = {
    service: 'examples',
    method: 'NotesStatsService.CountByOwners',
    payload: { ownerIds: [owner, 'nobody'] },
  };

  it('answers the port over gRPC (types from proto/)', async () => {
    const response = await app
      .get(GrpcTransport)
      .request<{ counts: Record<string, number> }>(call, { idempotent: true });
    expect(response.counts).toEqual({ [owner]: 2, nobody: 0 });
  });

  it('serves the NotesStats port through the client the router picks (TRANSPORT_ROUTES=examples=grpc)', async () => {
    const router = new TransportRouter(config, app.get(GrpcTransport), app.get(RabbitMqTransport));
    const counts = await new NotesStatsClient(router).countByOwners([owner, 'nobody']);
    expect([...counts]).toEqual([
      [owner, 2],
      ['nobody', 0],
    ]);
  });

  it('fails within the deadline, classified as transient, when the service is down', async () => {
    const down = new GrpcTransport({ ...config, grpc: { examplesUrl: '127.0.0.1:1', deadlineMs: 800 } });
    const started = performance.now();
    const error = await down.request(call, { idempotent: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationCallException);
    expect((error as IntegrationCallException).transient).toBe(true);
    expect(performance.now() - started).toBeLessThan(2500);
    down.onApplicationShutdown();
  });

  it('answers the same port over RabbitMQ RPC (direct reply-to, manual ack)', async () => {
    const response = await app
      .get(RabbitMqTransport)
      .request<{ counts: Record<string, number> }>(call, { timeoutMs: 5000 });
    expect(response.counts).toEqual({ [owner]: 2, nobody: 0 });
  });

  it('publishes domain events to the topic exchange with confirms and the event id as message id', async () => {
    const connection = await amqpConnect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, EXCHANGE, 'note.#');
    try {
      const NoteArchived = defineEvent<{ noteId: string }>('note.archived');
      const event = NoteArchived({ noteId: 'n1' }, new Date('2026-10-26T10:00:00Z'));
      // Bound by TransportModule when EVENTS_EXTERNAL=rabbitmq; built directly here.
      await new RabbitMqEventPublisher(app.get(RabbitMqTransport)).publish(event);
      let message: Awaited<ReturnType<typeof channel.get>> = false;
      for (let i = 0; i < 50 && !message; i += 1) {
        message = await channel.get(queue, { noAck: true });
        if (!message) await new Promise((r) => setTimeout(r, 50));
      }
      expect(message && message.properties.messageId).toBe(event.eventId);
      expect(message && JSON.parse(message.content.toString())).toMatchObject({
        type: 'note.archived',
        payload: { noteId: 'n1' },
      });
    } finally {
      await channel.close();
      await connection.close();
    }
  });
});
