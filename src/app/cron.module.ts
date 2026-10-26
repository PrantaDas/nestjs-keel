import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { CoreModule } from './core.module';

/** Scheduled jobs process (no HTTP). Feature cron modules are added here. */
@Module({
  imports: [CoreModule, HeartbeatModule.forProcess('cron'), ScheduleModule.forRoot()],
})
export class CronModule {}
