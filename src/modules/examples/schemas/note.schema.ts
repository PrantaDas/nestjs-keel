/*
 * ─── SCHEMA ──────────────────────────────────────────────────────────────────
 * One class per collection. Rules this file shows:
 *  - `baseSchemaOptions`: timestamps (from the injected clock), no `__v`, `_id` in responses.
 *  - Every `@Prop` has an explicit `type` when TypeScript cannot express it at runtime (unions,
 *    enums, nullable dates, arrays, sub-documents).
 *  - Every query the repository runs has an index declared here, with a comment naming the query.
 *  - A day-scoped value (`createdDay`) is computed once, at write time, in the business zone, and
 *    stored. It is never recomputed from `createdAt` later (docs/conventions/time.md).
 *  - Opt-in helpers are plugged in explicitly (`softDeletePlugin`): nothing is forced on schemas.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { DayKey } from '@/common/time/time.types';
import { baseSchemaOptions } from '@/infra/database/base.schema';
import { softDeletePlugin } from '@/infra/database/soft-delete';

/**
 * A reminder as the person entered it ("14 Oct, 20:00, Asia/Dubai"), plus the UTC instant it
 * converts to. The zone is kept so the reminder can be shown and edited in the zone it was set in.
 */
@Schema({ _id: false })
export class NoteReminder {
  /** The instant the reminder fires (UTC). */
  @Prop({ type: Date, required: true })
  remindAt: Date;

  /** The wall-clock input, for display and editing. */
  @Prop({ type: String, required: true })
  date: string;

  @Prop({ type: String, required: true })
  time: string;

  /** IANA zone of the wall-clock input. */
  @Prop({ type: String, required: true })
  timeZone: string;

  /** Set when the reminder was sent (claimed): it never goes out twice. */
  @Prop({ type: Date, default: null })
  sentAt: Date | null;
}

const NoteReminderSchema = SchemaFactory.createForClass(NoteReminder);

@Schema({ ...baseSchemaOptions, collection: 'notes' })
export class Note {
  @Prop({ type: Types.ObjectId, required: true })
  ownerId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  title: string;

  @Prop({ type: String, default: '', maxlength: 10_000 })
  body: string;

  /** Lower-case labels, unique per note. */
  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Boolean, default: false })
  pinned: boolean;

  @Prop({ type: NoteReminderSchema, default: null })
  reminder: NoteReminder | null;

  /** Business day the note was created on (`BUSINESS_TIMEZONE`), stored at write time. */
  @Prop({ type: String, required: true })
  createdDay: DayKey;

  /**
   * Optimistic concurrency: every update must name the version it read (`expectedVersion`);
   * a stale write gets 409 instead of silently overwriting someone else's change.
   */
  @Prop({ type: Number, required: true, default: 1 })
  version: number;

  /** Added by `softDeletePlugin`; declared for typing only. */
  deletedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const NoteSchema = SchemaFactory.createForClass(Note);
NoteSchema.plugin(softDeletePlugin);

// List: the owner's live notes, pinned first, most recently updated next.
NoteSchema.index({ ownerId: 1, deletedAt: 1, pinned: -1, updatedAt: -1 });
// Filter by tag within the owner's notes.
NoteSchema.index({ ownerId: 1, tags: 1 });
// Reminder sweep: due reminders (sparse: only notes that have one; MongoDB partial indexes cannot
// filter on `null`, so "not sent yet" is checked by the query on the few due rows).
NoteSchema.index({ 'reminder.remindAt': 1 }, { sparse: true });
// Purge: notes soft-deleted long ago.
NoteSchema.index({ deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } });
// Admin stats through the NotesStats port: count per owner.
NoteSchema.index({ ownerId: 1, createdDay: 1 });
