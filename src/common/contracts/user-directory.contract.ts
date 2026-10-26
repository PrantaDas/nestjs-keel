/**
 * Owned by the users module. What other modules may know about accounts, and the one rule that
 * decides whether an account may be contacted at all.
 */

export type AccountStatus = 'active' | 'deactivated' | 'deletion_pending' | 'deleted';

/** Contact details of an account that may receive messages. Never return it from public routes. */
export interface ReachableUser {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  locale: string | null;
}

export interface PublicProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export abstract class UserDirectory {
  /**
   * The subset of `ids` that may be contacted right now (push, inbox, e-mail, SMS). Deactivated,
   * deletion-pending and deleted accounts are never returned. Callers check it when building an
   * audience **and** again right before sending.
   */
  abstract reachableUsers(ids: readonly string[]): Promise<Map<string, ReachableUser>>;

  /** Public profile views (one batched query); missing or deleted ids are absent from the map. */
  abstract findPublicProfiles(ids: readonly string[]): Promise<Map<string, PublicProfile>>;
}
