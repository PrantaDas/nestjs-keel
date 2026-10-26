import { Module } from '@nestjs/common';
import { OutboxRelayModule } from '@/infra/events/events.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { NotesJobsModule } from '@/modules/examples/notes.module';
import { IdentityJobsModule } from '@/modules/identity/identity.module';
import { NotificationsJobsModule } from '@/modules/notifications/notifications.module';
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
    // g:module worker (keep this marker: the generator adds new modules above it)
  ],
})
export class WorkerModule {}
