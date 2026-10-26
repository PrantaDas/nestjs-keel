import { Module } from '@nestjs/common';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { CoreModule } from './core.module';

/** BullMQ worker process (no HTTP). Feature job modules are added here. */
@Module({
  imports: [CoreModule, HeartbeatModule.forProcess('worker')],
})
export class WorkerModule {}
