import { defineEvent } from '@/common/events/domain-event';

/*
 * Domain events of the identity module that other modules handle (notifications removes push
 * tokens, examples deletes notes). Written to the outbox in the same transaction as the change.
 */

/** A new account exists (welcome e-mail, analytics). */
export const UserRegistered = defineEvent<{ userId: string; email: string | null }>('user.registered');

/** The account may no longer be contacted: deactivated by the user or disabled by an admin. */
export const UserDeactivated = defineEvent<{ userId: string; reason: 'self' | 'admin' | 'deletion' }>(
  'user.deactivated',
);

/** The account is reachable again (re-enabled, deletion cancelled). */
export const UserReactivated = defineEvent<{ userId: string }>('user.reactivated');

/** The grace period ended and the account was anonymised: remove everything owned by it. */
export const UserDeleted = defineEvent<{ userId: string }>('user.deleted');
