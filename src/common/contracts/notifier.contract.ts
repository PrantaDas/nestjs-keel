/**
 * Owned by the notifications module (device tokens, inbox, FCM, e-mail). Feature modules call this
 * instead of any push or mail code, so the transport can be swapped and is faked in tests.
 */

export type NotificationChannel = 'push' | 'inbox' | 'email';

export interface DirectNotification {
  /** Short stable source name, e.g. `note-reminder`, `payment-succeeded`. */
  source: string;
  /**
   * Idempotency: at most one delivery per (source, occurrenceKey, userId), however often this is
   * called (retries, duplicate jobs). E.g. `2026-10-14:note:<id>`.
   */
  occurrenceKey: string;
  userIds: readonly string[];
  title: string;
  body?: string;
  /** FCM data payload (string values), e.g. deep-link screen and ids. */
  data?: Record<string, string>;
  /** Default `['push', 'inbox']`. */
  channels?: readonly NotificationChannel[];
}

export abstract class Notifier {
  /**
   * Enqueues delivery and returns at once. Accounts that may not be contacted are dropped here and
   * again at send time; duplicates for the same key and user are ignored.
   */
  abstract notifyUsers(notification: DirectNotification): Promise<{ queued: number }>;
}
