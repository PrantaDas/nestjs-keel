import type { Aggregate, ClientSession, Model, Query, Schema, Types } from 'mongoose';
import { BaseRepository, LeanDoc } from './base.repository';

/**
 * Opt-in soft delete (ADR 0004): a schema that wants it calls `schema.plugin(softDeletePlugin)` and
 * its repository extends `SoftDeleteRepository`. Nothing else in the app is forced into it.
 *
 * - `deletedAt: Date | null` is added; `null` (or missing) means live.
 * - Every find / count / update / aggregate hides deleted documents unless the query sets
 *   `{ withDeleted: true }` in its options (or filters on `deletedAt` itself).
 * - Unique indexes that must allow re-creating a deleted value use a partial filter:
 *   `{ unique: true, partialFilterExpression: { deletedAt: null } }` is not allowed by MongoDB
 *   (null equality), so filter on `{ deletedAt: { $type: 'null' } }` instead.
 */
export interface SoftDeletable {
  deletedAt?: Date | null;
}

export interface SoftDeleteQueryOptions {
  /** Include soft-deleted documents. */
  withDeleted?: boolean;
}

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'countDocuments',
  'updateOne',
  'updateMany',
  'replaceOne',
] as const;

export function softDeletePlugin(schema: Schema): void {
  schema.add({ deletedAt: { type: Date, default: null } });

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function (this: Query<unknown, unknown>) {
      if ((this.getOptions() as SoftDeleteQueryOptions).withDeleted) return;
      if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'deletedAt')) return;
      void this.where({ deletedAt: null });
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if ((this.options as SoftDeleteQueryOptions).withDeleted) return;
    // After a leading $geoNear / $search stage (they must come first), else at the very start.
    const pipeline = this.pipeline();
    const first = pipeline[0] as object | undefined;
    const position = first && ('$geoNear' in first || '$search' in first) ? 1 : 0;
    pipeline.splice(position, 0, { $match: { deletedAt: null } });
  });
}

/** Repository base for soft-deletable collections: the delete verbs are soft, purge is explicit. */
export abstract class SoftDeleteRepository<T extends SoftDeletable> extends BaseRepository<T> {
  protected constructor(model: Model<T>) {
    super(model);
  }

  /** Marks a live document deleted; null when it does not exist or is already deleted. */
  softDeleteById(id: string | Types.ObjectId, at: Date, session?: ClientSession): Promise<LeanDoc<T> | null> {
    return this.model
      .findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: at } }, { returnDocument: 'after', session })
      .lean<LeanDoc<T>>()
      .exec();
  }

  /** Brings a soft-deleted document back; null when it is not deleted (or does not exist). */
  restoreById(id: string | Types.ObjectId, session?: ClientSession): Promise<LeanDoc<T> | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, deletedAt: { $ne: null } },
        { $set: { deletedAt: null } },
        { returnDocument: 'after', session },
      )
      .lean<LeanDoc<T>>()
      .exec();
  }

  /** A document whatever its state (admin views, restore screens). */
  findByIdWithDeleted(id: string | Types.ObjectId): Promise<LeanDoc<T> | null> {
    return this.model
      .findOne({ _id: id })
      .setOptions({ withDeleted: true } satisfies SoftDeleteQueryOptions)
      .lean<LeanDoc<T>>()
      .exec();
  }

  /**
   * Hard-deletes documents soft-deleted before `cutoff`, at most `limit` per call (crons call it
   * repeatedly). Returns how many were removed.
   */
  async purgeDeletedBefore(cutoff: Date, limit = 1000): Promise<number> {
    const ids = await this.model
      .find({ deletedAt: { $ne: null, $lt: cutoff } }, { _id: 1 })
      .limit(limit)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    if (!ids.length) return 0;
    const result = await this.model.deleteMany({ _id: { $in: ids.map((doc) => doc._id) } }).exec();
    return result.deletedCount;
  }
}
