/*
 * ─── EVENT HANDLERS (worker process) ─────────────────────────────────────────
 * Reactions to other modules' domain events, delivered by the outbox relay at least once: every
 * handler must be idempotent (deleting what is already gone is a no-op).
 */
import { Injectable, Logger } from '@nestjs/common';
import { UserDeleted } from '@/common/contracts/identity.events';
import type { DomainEvent } from '@/common/events/domain-event';
import { OnDomainEvent } from '@/infra/events/on-domain-event.decorator';
import { NotesService } from './notes.service';

@Injectable()
export class NotesEventHandlers {
  private readonly logger = new Logger(NotesEventHandlers.name);

  constructor(private readonly notes: NotesService) {}

  @OnDomainEvent(UserDeleted)
  async onUserDeleted(event: DomainEvent<{ userId: string }>): Promise<void> {
    const removed = await this.notes.removeAllForOwner(event.payload.userId);
    if (removed) this.logger.log({ userId: event.payload.userId, removed }, 'Notes of a deleted account removed');
  }
}
