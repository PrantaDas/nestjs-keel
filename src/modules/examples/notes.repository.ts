/*
 * ─── REPOSITORY ──────────────────────────────────────────────────────────────
 * The only class that touches the model. Services call intent-named methods (`listForOwner`,
 * `claimReminder`), never raw queries. Reads are lean (plain objects). Every filter here is backed
 * by an index declared on the schema. Soft-deleted notes are hidden automatically by the plugin;
 * `SoftDeleteRepository` adds `softDeleteById`, `restoreById` and `purgeDeletedBefore`.
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter, UpdateQuery } from 'mongoose';
import { Types } from 'mongoose';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { LeanDoc } from '@/infra/database/base.repository';
import { SoftDeleteRepository } from '@/infra/database/soft-delete';
import type { NoteQueryDto } from './dto/note.dto';
import { Note } from './schemas/note.schema';

export type NoteDoc = LeanDoc<Note>;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class NotesRepository extends SoftDeleteRepository<Note> {
  constructor(@InjectModel(Note.name) model: Model<Note>) {
    super(model);
  }

  /** The owner's notes, pinned first; `q` is an anchored, case-insensitive title prefix. */
  listForOwner(ownerId: string, query: NoteQueryDto): Promise<PaginatedResult<NoteDoc>> {
    const filter: QueryFilter<Note> = { ownerId: new Types.ObjectId(ownerId) };
    if (query.tag) filter.tags = query.tag.toLowerCase();
    if (query.q) filter.title = new RegExp(`^${escapeRegex(query.q)}`, 'i');
    const field = query.sort.replace(/^-/, '');
    return this.paginate(filter, {
      page: query.page,
      limit: query.limit,
      sort: { pinned: -1, [field]: query.sort.startsWith('-') ? -1 : 1, _id: -1 },
    });
  }

  /** A live note of this owner; another owner's note reads as missing (no existence leak). */
  findOwned(id: string, ownerId: string): Promise<NoteDoc | null> {
    return this.findOne({ _id: id, ownerId: new Types.ObjectId(ownerId) });
  }

  countLive(ownerId: string): Promise<number> {
    return this.count({ ownerId: new Types.ObjectId(ownerId) });
  }

  /**
   * Applies `update` only if the note is still at `expectedVersion`, and bumps the version; null
   * when the note is missing or someone else changed it first (the service tells which).
   */
  updateIfVersion(
    id: string,
    ownerId: string,
    expectedVersion: number,
    update: UpdateQuery<Note>,
    session?: ClientSession,
  ): Promise<NoteDoc | null> {
    return this.updateOne(
      { _id: id, ownerId: new Types.ObjectId(ownerId), version: expectedVersion },
      { ...update, $inc: { version: 1 } },
      session,
    );
  }

  /** Tag usage of the owner's live notes, most used first (aggregation; soft-deleted excluded by the plugin). */
  tagCounts(ownerId: string): Promise<Array<{ tag: string; count: number }>> {
    return this.aggregate([
      { $match: { ownerId: new Types.ObjectId(ownerId) } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 },
      { $project: { _id: 0, tag: '$_id', count: 1 } },
    ]);
  }

  /** Reminders due by `now` and not sent yet (bounded batch, oldest first). */
  dueReminders(now: Date, limit: number): Promise<NoteDoc[]> {
    return this.find(
      { 'reminder.remindAt': { $lte: now }, 'reminder.sentAt': null },
      { sort: { 'reminder.remindAt': 1 }, limit },
    );
  }

  /**
   * Claims a reminder: succeeds for exactly one caller, and only if the reminder was not changed
   * since it was queued (`remindAt` must still match). Returns the note when this caller won.
   */
  claimReminder(id: string, remindAt: Date, at: Date): Promise<NoteDoc | null> {
    return this.updateOne(
      { _id: id, 'reminder.remindAt': remindAt, 'reminder.sentAt': null },
      { $set: { 'reminder.sentAt': at } },
    );
  }

  /** Live note count per owner, in one aggregation (the NotesStats port). */
  async countByOwners(ownerIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ownerId: { $in: ownerIds.map((id) => new Types.ObjectId(id)) } } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((row) => [row._id.toHexString(), row.count]));
  }

  /** Every note of an owner, deleted or not (account deleted). */
  async deleteAllForOwner(ownerId: string): Promise<number> {
    const result = await this.model.deleteMany({ ownerId: new Types.ObjectId(ownerId) }).exec();
    return result.deletedCount;
  }
}
