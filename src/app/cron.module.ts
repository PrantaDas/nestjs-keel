import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { IdentityCronModule } from '@/modules/identity/identity.module';
import { NotificationsCronModule } from '@/modules/notifications/notifications.module';
import { CoreModule } from './core.module';

/** Scheduled jobs process (no HTTP). Every job is a `@LockedCron`: safe to run several instances. */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('cron'),
    ScheduleModule.forRoot(),
    IdentityCronModule,
    NotificationsCronModule,
    // g:module cron (keep this marker: the generator adds new modules above it)
  ],
})
export class CronModule {}
