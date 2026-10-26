import type { AccountStatus } from '@/common/contracts/user-directory.contract';

/**
 * THE rule for contacting people, in one place: only an active account receives anything (push,
 * inbox, e-mail, SMS). A deactivated, deletion-pending or deleted account asked us to stop.
 * `UserDirectory.reachableUsers` applies it; the notifications module asks twice (audience and send).
 */
export function isReachable(account: { status: AccountStatus }): boolean {
  return account.status === 'active';
}

/** Statuses from which a person may sign in (a self-deactivated or deletion-pending account reactivates). */
export function canSignIn(account: { status: AccountStatus; deactivatedBy: 'self' | 'admin' | null }): boolean {
  if (account.status === 'deleted') return false;
  return !(account.status === 'deactivated' && account.deactivatedBy === 'admin');
}
