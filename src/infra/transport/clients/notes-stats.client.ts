import { Injectable } from '@nestjs/common';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import type { CountByOwnersRequest, CountByOwnersResponse } from '../grpc/generated/examples/v1/notes_stats';
import { TransportRouter } from '../transport.router';

/**
 * `NotesStats` when the examples module runs as its own service (`TRANSPORT_ROUTES=examples=grpc`
 * or `=rabbitmq`): the same port, implemented over the wire. Callers (identity's admin detail)
 * cannot tell the difference. A read, so it is retried on transient failures.
 */
@Injectable()
export class NotesStatsClient extends NotesStats {
  constructor(private readonly router: TransportRouter) {
    super();
  }

  async countByOwners(ownerIds: readonly string[]): Promise<Map<string, number>> {
    const response = await this.router
      .for('examples')
      .request<CountByOwnersResponse, CountByOwnersRequest>(
        { service: 'examples', method: 'NotesStatsService.CountByOwners', payload: { ownerIds: [...ownerIds] } },
        { idempotent: true },
      );
    return new Map(ownerIds.map((id) => [id, response.counts?.[id] ?? 0]));
  }
}
