import { DynamicModule, Module } from '@nestjs/common';
import { HeartbeatService, PROCESS_MODE, type ProcessMode } from './heartbeat.service';

/** Imported once per process module (api, socket, worker, cron) with that process's mode. */
@Module({})
export class HeartbeatModule {
  static forProcess(mode: ProcessMode): DynamicModule {
    return {
      module: HeartbeatModule,
      providers: [{ provide: PROCESS_MODE, useValue: mode }, HeartbeatService],
    };
  }
}
