/*
 * ─── MODULE WIRING ───────────────────────────────────────────────────────────
 * One codebase, five processes: a feature ships one small module per process it runs in, all
 * importing its core module. Register each in the matching root module under `src/app/`:
 *   NotesApiModule      → ApiModule      (REST controllers)
 *   NotesJobsModule     → WorkerModule   (processor, domain-event handlers)
 *   NotesCronModule     → CronModule     (@LockedCron jobs)
 *   NotesRealtimeModule → SocketModule   (gateway)
 *   NotesGraphqlModule  → GraphqlAppModule (resolver)
 * The core module is `@Global` only because it provides a port (`NotesStats`) other modules
 * consume; a module without ports keeps its core module local.
 */
import { BullModule } from '@nestjs/bullmq';
import { Global, Module, Provider } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
// #region port (pnpm g:module leaves this out of new modules)
import { NotesStats } from '@/common/contracts/notes-stats.contract';
// #endregion port
import { features } from '@/config/configuration';
import { QueueName } from '@/infra/queue/queue.constants';
import { NotesController, NotesV1Controller, NotesV2Controller } from './notes.controller';
import { NotesCron } from './notes.cron';
import { NotesGateway } from './notes.gateway';
import { NotesEventHandlers } from './notes.handlers';
import { NotesProcessor } from './notes.processor';
import { NotesRepository } from './notes.repository';
import { NotesResolver } from './notes.resolver';
// #region port
import { NotesStatsAdapter } from './notes-stats.adapter';
import { NotesRpcController } from './notes.rpc';
// #endregion port
import { NotesService } from './notes.service';
import { Note, NoteSchema } from './schemas/note.schema';

const notesQueue = BullModule.registerQueue({ name: QueueName.NOTES });

// #region port
/**
 * This module answers its port in-process unless TRANSPORT_ROUTES sends `examples` over the wire;
 * then infra/transport binds a network client instead (docs/architecture/microservices.md).
 */
const localPorts: Provider[] =
  features.transportRoute('examples') === 'inprocess'
    ? [NotesStatsAdapter, { provide: NotesStats, useExisting: NotesStatsAdapter }]
    : [];
// #endregion port

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Note.name, schema: NoteSchema }]), notesQueue],
  providers: [NotesRepository, NotesService, ...localPorts],
  // The queue is exported for the cron (producer) and the worker (processor) modules.
  exports: [NotesService, notesQueue, ...(localPorts.length ? [NotesStats] : [])],
})
export class NotesCoreModule {}

@Module({
  imports: [NotesCoreModule],
  controllers: [NotesController, NotesV1Controller, NotesV2Controller],
})
export class NotesApiModule {}

@Module({
  imports: [NotesCoreModule],
  providers: [NotesProcessor, NotesEventHandlers],
})
export class NotesJobsModule {}

@Module({
  imports: [NotesCoreModule],
  providers: [NotesCron],
})
export class NotesCronModule {}

@Module({
  imports: [NotesCoreModule],
  providers: [NotesGateway],
})
export class NotesRealtimeModule {}

@Module({
  imports: [NotesCoreModule],
  providers: [NotesResolver],
})
export class NotesGraphqlModule {}

// #region port
/** The port over the network: gRPC server (grpc process) and RabbitMQ RPC (worker). */
@Module({
  imports: [NotesCoreModule],
  controllers: [NotesRpcController],
})
export class NotesRpcModule {}
// #endregion port
