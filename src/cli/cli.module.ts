import { Module } from '@nestjs/common';
import { CoreModule } from '@/app/core.module';
import { AuditModule } from '@/modules/audit/audit.module';
import { NotesCoreModule } from '@/modules/examples/notes.module';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';
import { PaymentsCoreModule } from '@/modules/payments/payments.module';

/**
 * What command-line tools load: the shared infrastructure and every feature's core module (models,
 * services, ports), without HTTP, workers, crons or heartbeats. `sync-indexes` relies on it listing
 * every module that owns a collection.
 */
@Module({
  imports: [
    CoreModule,
    AuditModule,
    IdentityCoreModule,
    NotificationsCoreModule,
    NotesCoreModule,
    PaymentsCoreModule,
    // g:module cli (keep this marker: the generator adds new modules above it)
  ],
})
export class CliModule {}
