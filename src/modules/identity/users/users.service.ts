import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { isValidObjectId, Types } from 'mongoose';
import { AuthUser, Role } from '@/common/auth/auth.types';
import { UserDeactivated, UserDeleted, UserReactivated } from '@/common/contracts/identity.events';
import { NotesStats } from '@/common/contracts/notes-stats.contract';
import { PublicProfile, ReachableUser, UserDirectory } from '@/common/contracts/user-directory.contract';
import { RequestContext } from '@/common/context/request-context';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { TimeService } from '@/common/time/time.service';
import { authConfig, storageConfig } from '@/config/configuration';
import { TransactionService } from '@/infra/database/transaction.service';
import { OutboxService } from '@/infra/events/outbox.service';
import { FileStorage } from '@/integrations/storage/storage.port';
import { IdentityErrors, IdentityException } from '../identity.errors';
import { SessionService } from '../sessions/session.service';
import { isReachable } from './account-rules';
import { AdminUpdateUserDto, AdminUserQueryDto } from './dto/admin-user.dto';
import { AvatarUploadDto, UpdateProfileDto } from './dto/user.dto';
import { hashPassword, verifyPassword } from './password';
import { User } from './schemas/user.schema';
import { UserDoc, UsersRepository } from './users.repository';
import { AdminUserView, toAdminUserView, toUserView, UserView } from './users.views';

const AVATAR_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const DAY_MS = 86_400_000;

export interface NewAccount {
  name: string;
  email?: string | null;
  phone?: string | null;
  password?: string | null;
  role?: Role;
  emailVerified?: boolean;
}

/**
 * Accounts: profile, picture, password, deactivation, deletion with a grace period, and the
 * admin-side list / detail / update / disable. Also the `UserDirectory` other modules use to find
 * who may be contacted (the rule is `isReachable`, in one place).
 */
@Injectable()
export class UsersService extends UserDirectory {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionService,
    private readonly outbox: OutboxService,
    private readonly storage: FileStorage,
    private readonly time: TimeService,
    @Inject(authConfig.KEY) private readonly auth: ConfigType<typeof authConfig>,
    @Inject(storageConfig.KEY) private readonly storageSettings: ConfigType<typeof storageConfig>,
    // Owned by the examples module; absent when it is not loaded (counts then read 0).
    @Optional() private readonly notesStats?: NotesStats,
  ) {
    super();
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  async create(input: NewAccount, session?: ClientSession): Promise<UserDoc> {
    const now = this.time.now();
    return this.users.create(
      {
        name: input.name.trim(),
        nameSearch: input.name.trim().toLowerCase(),
        email: input.email ?? null,
        emailVerifiedAt: input.emailVerified ? now : null,
        phone: input.phone ?? null,
        passwordHash: input.password ? await hashPassword(input.password) : null,
        passwordSetAt: input.password ? now : null,
        role: input.role ?? Role.USER,
        status: 'active',
      },
      session,
    );
  }

  async findOrFail(id: string): Promise<UserDoc> {
    const user = isValidObjectId(id) ? await this.users.findById(id) : null;
    if (!user || user.status === 'deleted') throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    return user;
  }

  async me(userId: string): Promise<UserView> {
    return this.view(await this.findOrFail(userId));
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserView> {
    const user = await this.users.updateById(userId, {
      $set: {
        ...(dto.name !== undefined ? { name: dto.name.trim(), nameSearch: dto.name.trim().toLowerCase() } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.timeZone !== undefined ? { timeZone: dto.timeZone } : {}),
      },
    });
    if (!user) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    return this.view(user);
  }

  // ── Profile picture (presigned upload, then confirm) ────────────────────

  async createAvatarUpload(userId: string, dto: AvatarUploadDto) {
    const key = `avatars/${userId}/${randomUUID()}.${AVATAR_EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.createUploadUrl(key, dto.contentType, dto.sizeBytes);
    return { uploadUrl: upload.url, method: upload.method, headers: upload.headers, key, expiresAt: upload.expiresAt };
  }

  /** The client uploaded to the presigned URL; check the object really exists before using it. */
  async confirmAvatar(userId: string, key: string): Promise<UserView> {
    if (!key.startsWith(`avatars/${userId}/`)) throw new IdentityException(IdentityErrors.AVATAR_UPLOAD_MISSING);
    const object = await this.storage.headObject(key);
    if (
      !object ||
      object.sizeBytes > this.storageSettings.maxUploadBytes ||
      !object.contentType?.startsWith('image/')
    ) {
      throw new IdentityException(IdentityErrors.AVATAR_UPLOAD_MISSING);
    }
    const previous = await this.findOrFail(userId);
    const user = await this.users.updateById(userId, { $set: { avatarKey: key } });
    if (previous.avatarKey && previous.avatarKey !== key) this.deleteFile(previous.avatarKey);
    return this.view(user!);
  }

  async removeAvatar(userId: string): Promise<UserView> {
    const previous = await this.findOrFail(userId);
    const user = await this.users.updateById(userId, { $set: { avatarKey: null } });
    if (previous.avatarKey) this.deleteFile(previous.avatarKey);
    return this.view(user!);
  }

  // ── Password ────────────────────────────────────────────────────────────

  /** Changes (or sets a first) password and signs out every other device. */
  async changePassword(user: AuthUser, currentPassword: string | undefined, newPassword: string): Promise<void> {
    const account = await this.users.findByIdWithPassword(user.id);
    if (!account) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    if (account.passwordHash && !(await verifyPassword(currentPassword ?? '', account.passwordHash))) {
      throw new IdentityException(IdentityErrors.PASSWORD_INCORRECT);
    }
    await this.setPassword(user.id, newPassword);
    await this.sessions.revokeAll(user.id, user.sessionId);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.users.updateById(userId, {
      $set: {
        passwordHash: await hashPassword(password),
        passwordSetAt: this.time.now(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  }

  /** Accounts with a password confirm destructive actions with it; code-only accounts are signed in already. */
  async confirmPassword(userId: string, password: string | undefined): Promise<void> {
    const account = await this.users.findByIdWithPassword(userId);
    if (!account) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    if (account.passwordHash && !(await verifyPassword(password ?? '', account.passwordHash))) {
      throw new IdentityException(IdentityErrors.PASSWORD_INCORRECT);
    }
  }

  // ── Deactivation and deletion ───────────────────────────────────────────

  /** The person deactivates their account: signed out everywhere, contacted no more; signing in reactivates. */
  async deactivateSelf(userId: string, password: string | undefined): Promise<void> {
    await this.confirmPassword(userId, password);
    await this.setInactive(userId, { status: 'deactivated', by: 'self' });
    await this.sessions.revokeAll(userId);
  }

  /**
   * Schedules deletion after USER_DELETION_GRACE_DAYS. The account stops receiving anything at once;
   * other devices are signed out; signing in again (or `cancelDeletion`) cancels it.
   */
  async requestDeletion(user: AuthUser, password: string | undefined): Promise<UserView> {
    await this.confirmPassword(user.id, password);
    const account = await this.findOrFail(user.id);
    if (account.status === 'deletion_pending') throw new IdentityException(IdentityErrors.ACCOUNT_DELETION_PENDING);
    const updated = await this.setInactive(user.id, { status: 'deletion_pending', by: 'self' });
    await this.sessions.revokeAll(user.id, user.sessionId);
    return this.view(updated);
  }

  async cancelDeletion(userId: string): Promise<UserView> {
    const account = await this.findOrFail(userId);
    if (account.status !== 'deletion_pending') throw new IdentityException(IdentityErrors.DELETION_NOT_PENDING);
    return this.view(await this.reactivate(userId));
  }

  /** Back to active (sign-in after self-deactivation or pending deletion, admin re-enable). */
  async reactivate(userId: string): Promise<UserDoc> {
    const now = this.time.now();
    return this.transactions.run(async (session) => {
      const user = await this.users.updateById(
        userId,
        {
          $set: {
            status: 'active',
            deactivatedAt: null,
            deactivatedBy: null,
            deletionRequestedAt: null,
            deletionDueAt: null,
          },
        },
        session,
      );
      if (!user) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
      await this.outbox.add(UserReactivated({ userId }, now), session);
      return user;
    });
  }

  /**
   * Runs a due deletion (worker): anonymises the account in place, removes its picture, signs it out
   * and tells other modules (`user.deleted`) to remove what it owns. Re-checks the request, so a
   * cancelled or repeated job does nothing.
   */
  async anonymize(userId: string): Promise<boolean> {
    const now = this.time.now();
    const before = await this.users.findById(userId);
    if (!before || before.status !== 'deletion_pending' || !before.deletionDueAt || before.deletionDueAt > now) {
      return false;
    }
    await this.transactions.run(async (session) => {
      await this.users.updateOne(
        { _id: before._id, status: 'deletion_pending' },
        {
          $set: {
            status: 'deleted',
            deletedAt: now,
            name: 'Deleted account',
            nameSearch: 'deleted account',
            email: null,
            emailVerifiedAt: null,
            phone: null,
            phoneVerifiedAt: null,
            passwordHash: null,
            passwordSetAt: null,
            avatarKey: null,
            locale: null,
            timeZone: null,
          },
        },
        session,
      );
      await this.outbox.add(UserDeleted({ userId }, now), session);
    });
    await this.sessions.revokeAll(userId);
    if (before.avatarKey) this.deleteFile(before.avatarKey);
    this.logger.log({ userId }, 'Account anonymised after the deletion grace period');
    return true;
  }

  dueDeletions(limit: number): Promise<UserDoc[]> {
    return this.users.findDueDeletions(this.time.now(), limit);
  }

  // ── Admin ───────────────────────────────────────────────────────────────

  async adminList(query: AdminUserQueryDto): Promise<PaginatedResult<AdminUserView>> {
    const field = query.sort.replace(/^-/, '');
    const page = await this.users.search({
      q: query.q,
      role: query.role,
      status: query.status,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      sort: { [field === 'name' ? 'nameSearch' : field]: query.sort.startsWith('-') ? -1 : 1, _id: -1 },
      page: query.page,
      limit: query.limit,
    });
    const items = await Promise.all(page.items.map((user) => this.adminView(user)));
    return new PaginatedResult(items, page.meta);
  }

  async adminDetail(id: string) {
    const user = await this.findOrFail(id);
    const [view, sessions, counts] = await Promise.all([
      this.adminView(user),
      this.sessions.list(id),
      this.notesStats?.countByOwners([id]) ?? Promise.resolve(new Map<string, number>()),
    ]);
    return {
      ...view,
      notesCount: counts.get(id) ?? 0,
      sessions: sessions.map((s) => ({
        _id: s.id,
        device: s.device,
        ip: s.ip,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      })),
    };
  }

  async adminUpdate(actor: AuthUser, id: string, dto: AdminUpdateUserDto): Promise<AdminUserView> {
    const target = await this.findOrFail(id);
    if (dto.role !== undefined && dto.role !== target.role) {
      if (actor.role !== Role.SUPER_ADMIN) throw new IdentityException(IdentityErrors.ROLE_CHANGE_FORBIDDEN);
      if (actor.id === id) throw new IdentityException(IdentityErrors.CANNOT_CHANGE_SELF);
      if (target.role === Role.SUPER_ADMIN && (await this.users.countActiveSuperAdmins()) <= 1) {
        throw new IdentityException(IdentityErrors.LAST_SUPER_ADMIN);
      }
    }
    this.assertCanManage(actor, target);
    const update: Partial<User> = {};
    if (dto.name !== undefined) {
      Object.assign(update, { name: dto.name.trim(), nameSearch: dto.name.trim().toLowerCase() });
    }
    if (dto.role !== undefined) update.role = dto.role;
    const updated = await this.users.updateById(id, { $set: update });
    if (dto.role !== undefined && dto.role !== target.role) await this.sessions.setRole(id, dto.role);
    RequestContext.recordAudit({ resourceId: id, before: pick(target), after: pick(updated!) });
    return this.adminView(updated!);
  }

  /** Disables an account: signed out everywhere at once, cannot sign in, receives nothing. */
  async adminDisable(actor: AuthUser, id: string): Promise<AdminUserView> {
    const target = await this.findOrFail(id);
    if (actor.id === id) throw new IdentityException(IdentityErrors.CANNOT_CHANGE_SELF);
    this.assertCanManage(actor, target);
    if (target.role === Role.SUPER_ADMIN && (await this.users.countActiveSuperAdmins()) <= 1) {
      throw new IdentityException(IdentityErrors.LAST_SUPER_ADMIN);
    }
    const updated = await this.setInactive(id, { status: 'deactivated', by: 'admin' });
    await this.sessions.revokeAll(id);
    RequestContext.recordAudit({ resourceId: id, before: pick(target), after: pick(updated) });
    return this.adminView(updated);
  }

  async adminEnable(actor: AuthUser, id: string): Promise<AdminUserView> {
    const target = await this.findOrFail(id);
    this.assertCanManage(actor, target);
    if (target.status === 'active') return this.adminView(target);
    const updated = await this.reactivate(id);
    RequestContext.recordAudit({ resourceId: id, before: pick(target), after: pick(updated) });
    return this.adminView(updated);
  }

  async adminRevokeSessions(actor: AuthUser, id: string): Promise<number> {
    const target = await this.findOrFail(id);
    this.assertCanManage(actor, target);
    return this.sessions.revokeAll(id);
  }

  // ── UserDirectory (port for other modules) ──────────────────────────────

  async reachableUsers(ids: readonly string[]): Promise<Map<string, ReachableUser>> {
    const valid = [...new Set(ids)].filter((id) => isValidObjectId(id)).map((id) => new Types.ObjectId(id));
    const users = valid.length ? await this.users.findManyByIds(valid) : [];
    return new Map(
      users
        .filter((user) => isReachable(user))
        .map((user) => [
          user._id.toHexString(),
          {
            id: user._id.toHexString(),
            name: user.name,
            email: user.email,
            emailVerified: Boolean(user.emailVerifiedAt),
            phone: user.phone,
            locale: user.locale,
          },
        ]),
    );
  }

  async findPublicProfiles(ids: readonly string[]): Promise<Map<string, PublicProfile>> {
    const valid = [...new Set(ids)].filter((id) => isValidObjectId(id)).map((id) => new Types.ObjectId(id));
    const users = valid.length ? await this.users.findManyByIds(valid) : [];
    const views = await Promise.all(
      users
        .filter((user) => user.status !== 'deleted')
        .map(async (user) => ({ id: user._id.toHexString(), name: user.name, avatarUrl: await this.avatarUrl(user) })),
    );
    return new Map(views.map((view) => [view.id, view]));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  async view(user: UserDoc): Promise<UserView> {
    return toUserView(user, await this.avatarUrl(user));
  }

  private async adminView(user: UserDoc): Promise<AdminUserView> {
    return toAdminUserView(user, await this.avatarUrl(user));
  }

  /** Public CDN URL when configured, else a short-lived signed URL; never the storage key itself. */
  private async avatarUrl(user: UserDoc): Promise<string | null> {
    if (!user.avatarKey) return null;
    try {
      return this.storage.publicUrl(user.avatarKey) ?? (await this.storage.createDownloadUrl(user.avatarKey));
    } catch (err) {
      // Storage not configured or down: the profile still loads, without a picture.
      this.logger.warn({ err, userId: user._id }, 'Avatar URL unavailable');
      return null;
    }
  }

  /** Admins manage users; only super admins manage admins. */
  private assertCanManage(actor: AuthUser, target: UserDoc): void {
    if (target.role !== Role.USER && actor.role !== Role.SUPER_ADMIN) {
      throw new IdentityException(IdentityErrors.ROLE_CHANGE_FORBIDDEN);
    }
  }

  private async setInactive(
    userId: string,
    change: { status: 'deactivated' | 'deletion_pending'; by: 'self' | 'admin' },
  ): Promise<UserDoc> {
    const now = this.time.now();
    const deletion = change.status === 'deletion_pending';
    return this.transactions.run(async (session) => {
      const user = await this.users.updateById(
        userId,
        {
          $set: {
            status: change.status,
            deactivatedAt: now,
            deactivatedBy: change.by,
            deletionRequestedAt: deletion ? now : null,
            deletionDueAt: deletion ? new Date(now.getTime() + this.auth.deletionGraceDays * DAY_MS) : null,
          },
        },
        session,
      );
      if (!user) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
      await this.outbox.add(UserDeactivated({ userId, reason: deletion ? 'deletion' : change.by }, now), session);
      return user;
    });
  }

  private deleteFile(key: string): void {
    this.storage.delete(key).catch((err: unknown) => this.logger.warn({ err, key }, 'Old file not deleted'));
  }
}

/** The fields an admin change touches, for the audit trail (never hashes). */
function pick(user: UserDoc) {
  return { name: user.name, role: user.role, status: user.status, deactivatedBy: user.deactivatedBy };
}
