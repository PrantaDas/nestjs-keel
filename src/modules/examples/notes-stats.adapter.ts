/*
 * ─── PORT ADAPTER ────────────────────────────────────────────────────────────
 * What this module offers other modules, behind the abstract class they depend on
 * (`common/contracts/notes-stats.contract.ts`). Kept apart from the service so the port's shape and
 * the module's internals can change independently, and so the same port can be served over the
 * network (notes.rpc.ts) when the module is extracted.
 */
import { Injectable } from '@nestjs/common';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import { NotesService } from './notes.service';

@Injectable()
export class NotesStatsAdapter extends NotesStats {
  constructor(private readonly notes: NotesService) {
    super();
  }

  countByOwners(ownerIds: readonly string[]): Promise<Map<string, number>> {
    return this.notes.countByOwners(ownerIds);
  }
}
