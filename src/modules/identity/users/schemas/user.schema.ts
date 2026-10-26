import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Role } from '@/common/auth/auth.types';
import type { AccountStatus } from '@/common/contracts/user-directory.contract';
import { baseSchemaOptions } from '@/infra/database/base.schema';

export const ACCOUNT_STATUSES: readonly AccountStatus[] = ['active', 'deactivated', 'deletion_pending', 'deleted'];

/**
 * People and staff in one collection; `role` tells them apart (ADR 0005). Contact fields are
 * optional so an account can sign up with e-mail, phone or both. Deleted accounts are anonymised
 * in place (status `deleted`, contact data cleared) rather than removed, so references stay valid.
 */
@Schema({ ...baseSchemaOptions, collection: 'users' })
export class User {
  /** Lower-cased and trimmed. Unique among accounts that have one. */
  @Prop({ type: String, default: null, lowercase: true, trim: true })
  email: string | null;

  @Prop({ type: Date, default: null })
  emailVerifiedAt: Date | null;

  /** E.164 (`+14155550123`). Unique among accounts that have one. */
  @Prop({ type: String, default: null })
  phone: string | null;

  @Prop({ type: Date, default: null })
  phoneVerifiedAt: Date | null;

  @Prop({ required: true, trim: true, maxlength: 100 })
  name: string;

  /** Lower-cased name for anchored prefix search (admin list), kept in sync by the service. */
  @Prop({ required: true })
  nameSearch: string;

  /** `scrypt$…` (users/password.ts). Null for accounts that only sign in with codes. Never selected by default. */
  @Prop({ type: String, default: null, select: false })
  passwordHash: string | null;

  /** Readable stand-in for "has a password" (the hash itself is never selected). */
  @Prop({ type: Date, default: null })
  passwordSetAt: Date | null;

  @Prop({ type: String, required: true, enum: Object.values(Role), default: Role.USER })
  role: Role;

  @Prop({ type: String, required: true, enum: ACCOUNT_STATUSES, default: 'active' })
  status: AccountStatus;

  /** Storage key of the profile picture (never sent to clients: they get a URL). */
  @Prop({ type: String, default: null })
  avatarKey: string | null;

  @Prop({ type: String, default: null })
  locale: string | null;

  /** IANA zone for display; never used to decide which day a record belongs to. */
  @Prop({ type: String, default: null })
  timeZone: string | null;

  @Prop({ required: true, default: 0 })
  failedLoginCount: number;

  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  @Prop({ type: Date, default: null })
  deactivatedAt: Date | null;

  /** `self`: signing in again reactivates. `admin`: only an admin can re-enable the account. */
  @Prop({ type: String, enum: ['self', 'admin', null], default: null })
  deactivatedBy: 'self' | 'admin' | null;

  @Prop({ type: Date, default: null })
  deletionRequestedAt: Date | null;

  /** When the pending deletion runs (request + USER_DELETION_GRACE_DAYS). */
  @Prop({ type: Date, default: null })
  deletionDueAt: Date | null;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Sign-in and uniqueness (only accounts that have the field; `$type` because null equality cannot be partial).
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
// Admin list: filter by role / status, newest first; prefix search on name.
UserSchema.index({ role: 1, status: 1, createdAt: -1 });
UserSchema.index({ nameSearch: 1 });
// Deletion sweep: due pending deletions.
UserSchema.index({ status: 1, deletionDueAt: 1 }, { partialFilterExpression: { status: 'deletion_pending' } });
