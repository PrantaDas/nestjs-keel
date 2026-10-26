/*
 * ─── DOMAIN EVENTS ───────────────────────────────────────────────────────────
 * Facts other modules (or other services, through RabbitMQ) may react to. Written to the outbox in
 * the same transaction as the change (NotesService), delivered at least once by the worker. An
 * event another module handles is declared in `common/contracts/` instead; these are only
 * published (and handled nowhere in-process): with EVENTS_EXTERNAL=rabbitmq they leave the process.
 */
import { defineEvent } from '@/common/events/domain-event';

export const NoteCreated = defineEvent<{ noteId: string; ownerId: string }>('note.created');
export const NoteDeleted = defineEvent<{ noteId: string; ownerId: string }>('note.deleted');
