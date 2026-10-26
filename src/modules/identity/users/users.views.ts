import type { AccountStatus } from '@/common/contracts/user-directory.contract';
import type { Role } from '@/common/auth/auth.types';
import type { UserDoc } from './users.repository';

/** What `GET /users/me` returns. Views, not documents: no hashes, no storage keys, no counters. */
export interface UserView {
  _id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  role: Role;
  status: AccountStatus;
  avatarUrl: string | null;
  locale: string | null;
  timeZone: string | null;
  hasPassword: boolean;
  deletionDueAt: Date | null;
  createdAt: Date;
}

export interface AdminUserView extends UserView {
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  deactivatedAt: Date | null;
}

export function toUserView(user: UserDoc, avatarUrl: string | null): UserView {
  return {
    _id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    phone: user.phone,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    role: user.role,
    status: user.status,
    avatarUrl,
    locale: user.locale,
    timeZone: user.timeZone,
    hasPassword: Boolean(user.passwordSetAt),
    deletionDueAt: user.deletionDueAt,
    createdAt: user.createdAt,
  };
}

export function toAdminUserView(user: UserDoc, avatarUrl: string | null): AdminUserView {
  return {
    ...toUserView(user, avatarUrl),
    lastLoginAt: user.lastLoginAt,
    lockedUntil: user.lockedUntil,
    deactivatedAt: user.deactivatedAt,
  };
}
