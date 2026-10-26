import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import type { DomainEvent } from '@/common/events/domain-event';
import { OutboxEvent } from './outbox.schema';

/**
 * Writes domain events to the outbox. Pass the transaction `session` of the state change: the
 * event then commits (or rolls back) with it. Without a session the write is standalone, which is
 * only right when there is no state change to tie it to.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectModel(OutboxEvent.name) private readonly model: Model<OutboxEvent>) {}

  async add(events: DomainEvent | readonly DomainEvent[], session?: ClientSession): Promise<void> {
    const list: readonly DomainEvent[] = isList(events) ? events : [events];
    if (!list.length) return;
    await this.model.insertMany(
      list.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
        status: 'pending',
        attempts: 0,
        availableAt: event.occurredAt,
      })),
      { session, ordered: true },
    );
  }
}

function isList(events: DomainEvent | readonly DomainEvent[]): events is readonly DomainEvent[] {
  return Array.isArray(events);
}
