import { Module } from '@nestjs/common';
import { OutboxRelayModule } from '@/infra/events/events.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { RabbitMqServerModule } from '@/infra/transport/transport.module';
import { NotesJobsModule, NotesRpcModule } from '@/modules/examples/notes.module';
import { IdentityJobsModule } from '@/modules/identity/identity.module';
import { NotificationsJobsModule } from '@/modules/notifications/notifications.module';
import { PaymentsJobsModule } from '@/modules/payments/payments.module';
import { CoreModule } from './core.module';

/** BullMQ worker process (no HTTP): processors and domain-event handlers (the outbox relays here). */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('worker'),
    OutboxRelayModule,
    IdentityJobsModule,
    NotificationsJobsModule,
    NotesJobsModule,
    PaymentsJobsModule.forRoot(),
    // Ports served over RabbitMQ RPC (idle unless RABBITMQ_URL is set).
    RabbitMqServerModule,
    NotesRpcModule,
    // g:module worker (keep this marker: the generator adds new modules above it)
  ],
})
export class WorkerModule {}
