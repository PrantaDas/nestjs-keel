import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter, Types } from 'mongoose';
import { Role } from '@/common/auth/auth.types';
import type { AccountStatus } from '@/common/contracts/user-directory.contract';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { BaseRepository, LeanDoc, SortSpec } from '@/infra/database/base.repository';
import { User } from './schemas/user.schema';

export type UserDoc = LeanDoc<User>;
export type UserWithPassword = UserDoc & { passwordHash: string | null };

export interface UserSearch {
  q?: string;
  role?: Role;
  status?: AccountStatus;
  createdFrom?: Date;
  createdTo?: Date;
  sort: SortSpec;
  page: number;
  limit: number;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Data access for accounts. Query methods are named after what the caller wants. */
@Injectable()
export class UsersRepository extends BaseRepository<User> {
  constructor(@InjectModel(User.name) model: Model<User>) {
    super(model);
  }

  findByEmail(email: string): Promise<UserDoc | null> {
    return this.findOne({ email: email.toLowerCase() });
  }

  findByPhone(phone: string): Promise<UserDoc | null> {
    return this.findOne({ phone });
  }

  /** The only reads that load the password hash (sign-in, password change). */
  findByEmailWithPassword(email: string): Promise<UserWithPassword | null> {
    return this.model.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean<UserWithPassword>().exec();
  }

  findByIdWithPassword(id: string): Promise<UserWithPassword | null> {
    return this.model.findById(id).select('+passwordHash').lean<UserWithPassword>().exec();
  }

  /** Accounts by id in one query (directory lookups); invalid ids are the caller's to filter. */
  findManyByIds(ids: readonly (string | Types.ObjectId)[]): Promise<UserDoc[]> {
    return this.find({ _id: { $in: ids } });
  }

  /** Admin list: filters on indexed fields; `q` is an anchored, case-insensitive prefix of name or email. */
  search(query: UserSearch): Promise<PaginatedResult<UserDoc>> {
    const filter: QueryFilter<User> = {};
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    else filter.status = { $ne: 'deleted' };
    if (query.createdFrom || query.createdTo) {
      filter.createdAt = {
        ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
        ...(query.createdTo ? { $lt: query.createdTo } : {}),
      };
    }
    if (query.q) {
      const prefix = new RegExp(`^${escapeRegex(query.q.trim().toLowerCase())}`);
      filter.$or = [{ nameSearch: prefix }, { email: prefix }];
    }
    return this.paginate(filter, { page: query.page, limit: query.limit, sort: query.sort });
  }

  /**
   * Counts a failed password sign-in and locks the account once `maxFailed` is reached, in one
   * atomic update (concurrent attempts cannot slip past the limit).
   */
  recordFailedLogin(id: Types.ObjectId, maxFailed: number, lockUntil: Date): Promise<UserDoc | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id },
        [
          { $set: { failedLoginCount: { $add: ['$failedLoginCount', 1] } } },
          {
            $set: {
              lockedUntil: { $cond: [{ $gte: ['$failedLoginCount', maxFailed] }, lockUntil, '$lockedUntil'] },
              failedLoginCount: { $cond: [{ $gte: ['$failedLoginCount', maxFailed] }, 0, '$failedLoginCount'] },
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      )
      .lean<UserDoc>()
      .exec();
  }

  recordSuccessfulLogin(id: Types.ObjectId, at: Date): Promise<UserDoc | null> {
    return this.updateById(id, { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at } });
  }

  countActiveSuperAdmins(session?: ClientSession): Promise<number> {
    return this.model.countDocuments({ role: Role.SUPER_ADMIN, status: 'active' }, { session }).exec();
  }

  /** Pending deletions whose grace period is over (oldest first, bounded batch). */
  findDueDeletions(now: Date, limit: number): Promise<UserDoc[]> {
    return this.find(
      { status: 'deletion_pending', deletionDueAt: { $lte: now } },
      { sort: { deletionDueAt: 1 }, limit, projection: { _id: 1 } },
    );
  }
}
