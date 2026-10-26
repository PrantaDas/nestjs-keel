/*
 * ─── SERVICE ─────────────────────────────────────────────────────────────────
 * Business rules live here, and only here. Controllers, the GraphQL resolver, the socket gateway,
 * the processor and the cron all call the same methods, so a rule is enforced however a note is
 * reached. Patterns shown:
 *  - expected failures are domain exceptions from the module's catalogue (never `new Error()`);
 *  - time comes from `TimeService` (frozen in tests); day keys are computed once and stored;
 *  - a state change and its domain event commit together (`TransactionService` + outbox);
 *  - side effects after the commit are best effort: cache invalidation and realtime pushes never
 *    fail the request;
 *  - other modules are reached through ports (`Notifier`), and this module provides one
 *    (`NotesStats`) for others.
 */
import { Injectable, Logger } from '@nestjs/common';
import { isValidObjectId, Types } from 'mongoose';
import { Notifier } from '@/common/contracts/notifier.contract';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { TimeService } from '@/common/time/time.service';
import type { LocalDateTime } from '@/common/time/time.types';
import { CacheService } from '@/infra/cache/cache.service';
import { TransactionService } from '@/infra/database/transaction.service';
import { OutboxService } from '@/infra/events/outbox.service';
import { GraphqlPubSub } from '@/infra/graphql/graphql-pubsub';
import { RealtimeEmitter } from '@/infra/realtime/realtime-emitter.service';
import { CreateNoteDto, NoteQueryDto, UpdateNoteDto } from './dto/note.dto';
import { NotesErrors, NotesException } from './notes.errors';
import { NoteCreated, NoteDeleted } from './notes.events';
import { NoteDoc, NotesRepository } from './notes.repository';
import type { Note, NoteReminder } from './schemas/note.schema';

/** A person keeps at most this many live notes (protects the database from runaway clients). */
export const MAX_NOTES_PER_OWNER = 1000;
/** Deleted notes stay restorable this long, then the purge cron removes them. */
export const DELETED_RETENTION_DAYS = 30;
/** Event the socket clients of the owner receive after any change (docs/api/socket-events.md). */
export const NOTES_CHANGED_EVENT = 'notes:changed';

const DAY_MS = 86_400_000;
const TAGS_CACHE_SECONDS = 300;

@Injectable()
export class NotesService extends NotesStats {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly notes: NotesRepository,
    private readonly transactions: TransactionService,
    private readonly outbox: OutboxService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeEmitter,
    private readonly graphqlEvents: GraphqlPubSub,
    private readonly notifier: Notifier,
    private readonly time: TimeService,
  ) {
    super();
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Documents, not views: each API version (REST v1 / v2, GraphQL) maps them to its own shape. */
  list(ownerId: string, query: NoteQueryDto): Promise<PaginatedResult<NoteDoc>> {
    return this.notes.listForOwner(ownerId, query);
  }

  async get(ownerId: string, id: string): Promise<NoteDoc> {
    const note = isValidObjectId(id) ? await this.notes.findOwned(id, ownerId) : null;
    if (!note) throw new NotesException(NotesErrors.NOTE_NOT_FOUND);
    return note;
  }

  /** Read-through cache on the cache Redis (optional: without it this simply queries). */
  tags(ownerId: string): Promise<Array<{ tag: string; count: number }>> {
    return this.cache.wrap(`notes:tags:${ownerId}`, () => this.notes.tagCounts(ownerId), {
      ttlSeconds: TAGS_CACHE_SECONDS,
      tags: [`notes:${ownerId}`],
    });
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async create(ownerId: string, dto: CreateNoteDto): Promise<NoteDoc> {
    if ((await this.notes.countLive(ownerId)) >= MAX_NOTES_PER_OWNER) {
      throw new NotesException(NotesErrors.NOTE_LIMIT_REACHED);
    }
    const now = this.time.now();
    const note = await this.transactions.run(async (session) => {
      const created = await this.notes.create(
        {
          ownerId: toObjectId(ownerId),
          title: dto.title,
          body: dto.body ?? '',
          tags: dto.tags ?? [],
          pinned: dto.pinned ?? false,
          reminder: dto.reminder ? this.reminderFrom(dto.reminder, now) : null,
          // The day this record belongs to, decided now and stored (never derived from createdAt).
          createdDay: this.time.businessDay(now),
          version: 1,
        },
        session,
      );
      await this.outbox.add(NoteCreated({ noteId: created._id.toHexString(), ownerId }, now), session);
      return created;
    });
    this.changed(ownerId, note, 'created');
    return note;
  }

  async update(ownerId: string, id: string, dto: UpdateNoteDto): Promise<NoteDoc> {
    const current = await this.get(ownerId, id);
    const set: Partial<Note> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.body !== undefined) set.body = dto.body;
    if (dto.tags !== undefined) set.tags = dto.tags;
    if (dto.pinned !== undefined) set.pinned = dto.pinned;
    if (dto.reminder !== undefined) {
      set.reminder = dto.reminder ? this.reminderFrom(dto.reminder, this.time.now()) : null;
    }

    const updated = await this.notes.updateIfVersion(id, ownerId, dto.expectedVersion, { $set: set });
    if (!updated) {
      // The note exists (read above): someone saved a newer version in between.
      throw new NotesException(NotesErrors.NOTE_EDITED_ELSEWHERE, {
        details: [
          {
            field: 'expectedVersion',
            message: `The latest version is ${current.version}.`,
            latestVersion: current.version,
          },
        ],
      });
    }
    this.changed(ownerId, updated, 'updated');
    return updated;
  }

  /** Moves the note to the bin (restorable for DELETED_RETENTION_DAYS). */
  async remove(ownerId: string, id: string): Promise<void> {
    await this.get(ownerId, id);
    const now = this.time.now();
    const deleted = await this.transactions.run(async (session) => {
      const note = await this.notes.softDeleteById(id, now, session);
      if (note) await this.outbox.add(NoteDeleted({ noteId: id, ownerId }, now), session);
      return note;
    });
    if (!deleted) throw new NotesException(NotesErrors.NOTE_NOT_FOUND);
    this.changed(ownerId, deleted, 'deleted');
  }

  async restore(ownerId: string, id: string): Promise<NoteDoc> {
    const note = isValidObjectId(id) ? await this.notes.findByIdWithDeleted(id) : null;
    if (!note || !note.ownerId.equals(toObjectId(ownerId))) throw new NotesException(NotesErrors.NOTE_NOT_FOUND);
    const restored = await this.notes.restoreById(id);
    if (!restored) throw new NotesException(NotesErrors.NOTE_NOT_DELETED);
    this.changed(ownerId, restored, 'restored');
    return restored;
  }

  // ── Background work (called by the cron and the processor) ──────────────

  dueReminders(limit: number): Promise<NoteDoc[]> {
    return this.notes.dueReminders(this.time.now(), limit);
  }

  /**
   * Sends one reminder: claimed first (a second job or a retry finds it claimed and does nothing),
   * then handed to the `Notifier`, which dedupes again per occurrence and checks the owner may be
   * contacted. Returns false when there was nothing to send.
   */
  async sendReminder(noteId: string, remindAt: Date): Promise<boolean> {
    const note = await this.notes.claimReminder(noteId, remindAt, this.time.now());
    if (!note) return false;
    await this.notifier.notifyUsers({
      source: 'note-reminder',
      occurrenceKey: `${noteId}-${remindAt.toISOString()}`,
      userIds: [note.ownerId.toHexString()],
      title: `Reminder: ${note.title}`,
      body: note.body.slice(0, 200) || undefined,
      data: { screen: 'note', noteId },
    });
    return true;
  }

  /** Removes notes deleted more than DELETED_RETENTION_DAYS ago (batched; returns how many). */
  purgeDeleted(limit = 1000): Promise<number> {
    return this.notes.purgeDeletedBefore(this.time.after(-DELETED_RETENTION_DAYS * DAY_MS), limit);
  }

  /** Account deleted: every note goes, in the bin or not. */
  async removeAllForOwner(ownerId: string): Promise<number> {
    const removed = await this.notes.deleteAllForOwner(ownerId);
    await this.cache.invalidateTag(`notes:${ownerId}`);
    return removed;
  }

  // ── NotesStats port (used by the identity module's admin detail) ────────

  async countByOwners(ownerIds: readonly string[]): Promise<Map<string, number>> {
    const valid = ownerIds.filter((id) => isValidObjectId(id));
    const counts = valid.length ? await this.notes.countByOwners(valid) : new Map<string, number>();
    return new Map(ownerIds.map((id) => [id, counts.get(id) ?? 0]));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Wall-clock input → stored reminder. The DTO already rejected times skipped by daylight saving. */
  private reminderFrom(local: LocalDateTime, now: Date): NoteReminder {
    const remindAt = this.time.toInstant(local);
    if (remindAt <= now) {
      throw new NotesException(NotesErrors.REMINDER_IN_PAST, {
        details: [{ field: 'reminder.time', message: NotesErrors.REMINDER_IN_PAST.message }],
      });
    }
    return { remindAt, date: local.date, time: local.time, timeZone: local.timeZone, sentAt: null };
  }

  /**
   * After a committed change: drop cached tags and tell the owner's other devices, over Socket.IO
   * (`notes:changed` to the user's room) and GraphQL (`noteChanged` subscription). Best effort, never
   * throws: a client that misses a push re-syncs on its next read.
   */
  private changed(ownerId: string, note: NoteDoc, action: 'created' | 'updated' | 'deleted' | 'restored'): void {
    const change = { action, noteId: note._id.toHexString(), version: note.version };
    void this.cache.invalidateTag(`notes:${ownerId}`);
    this.realtime.toUser(ownerId, NOTES_CHANGED_EVENT, change);
    this.graphqlEvents
      .publish(NOTES_CHANGED_EVENT, { noteChanged: { ...change, ownerId } })
      .catch((err: unknown) => this.logger.warn({ err, ownerId }, 'GraphQL note change not published'));
  }
}

const toObjectId = (id: string) => new Types.ObjectId(id);
