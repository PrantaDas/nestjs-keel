import { Role } from './auth.types';

/**
 * Fine-grained capabilities, checked by `RolesGuard` from `@RequirePermissions(...)`. Roles map to
 * permissions in one table, so granting a capability to a role is a one-line change reviewed here.
 * Name them `<resource>:<action>`.
 */
export enum Permission {
  USERS_READ = 'users:read',
  USERS_WRITE = 'users:write',
  SESSIONS_REVOKE = 'sessions:revoke',
  OPS_READ = 'ops:read',
  OPS_WRITE = 'ops:write',
  AUDIT_READ = 'audit:read',
  NOTIFICATIONS_SEND = 'notifications:send',
  PAYMENTS_MANAGE = 'payments:manage',
}

const ALL = Object.values(Permission);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  [Role.USER]: [],
  [Role.ADMIN]: [
    Permission.USERS_READ,
    Permission.USERS_WRITE,
    Permission.SESSIONS_REVOKE,
    Permission.OPS_READ,
    Permission.NOTIFICATIONS_SEND,
  ],
  [Role.SUPER_ADMIN]: ALL,
});

export function hasPermissions(role: Role, required: readonly Permission[]): boolean {
  const granted = ROLE_PERMISSIONS[role] ?? [];
  return required.every((permission) => granted.includes(permission));
}
