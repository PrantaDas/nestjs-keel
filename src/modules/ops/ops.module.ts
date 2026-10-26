import { Module } from '@nestjs/common';
import { OpsController, OpsOutboxController, OpsProcessesController } from './ops.controller';
import { OpsService } from './ops.service';
import { QueueInspector } from './queue-inspector.service';

/** Ops API (api process): queue counts, failed-job review, parked events and running processes. Errors 7000–7099. */
@Module({
  controllers: [OpsController, OpsOutboxController, OpsProcessesController],
  providers: [QueueInspector, OpsService],
})
export class OpsModule {}
