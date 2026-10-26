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
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import { QueueName } from '@/infra/queue/queue.constants';
import { NotesController, NotesV1Controller, NotesV2Controller } from './notes.controller';
import { NotesCron } from './notes.cron';
import { NotesGateway } from './notes.gateway';
import { NotesEventHandlers } from './notes.handlers';
import { NotesProcessor } from './notes.processor';
import { NotesRepository } from './notes.repository';
import { NotesResolver } from './notes.resolver';
import { NotesService } from './notes.service';
import { Note, NoteSchema } from './schemas/note.schema';

const notesQueue = BullModule.registerQueue({ name: QueueName.NOTES });

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Note.name, schema: NoteSchema }]), notesQueue],
  providers: [NotesRepository, NotesService, { provide: NotesStats, useExisting: NotesService }],
  // The queue is exported for the cron (producer) and the worker (processor) modules.
  exports: [NotesService, NotesStats, notesQueue],
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
