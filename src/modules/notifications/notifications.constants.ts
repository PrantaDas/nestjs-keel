/** Every registered device joins this FCM topic (app-wide announcements). */
export const TOPIC_ALL = 'all';

/** Users per delivery job: one FCM `sendEach` batch holds 500 messages. */
export const USERS_PER_JOB = 500;

/** A `Notifier` call reaches at most this many accounts (larger audiences use a topic). */
export const MAX_RECIPIENTS = 10_000;

/** Deliveries left in `sending` this long belong to a crashed worker: closed as failed, never re-sent. */
export const STALE_SENDING_MS = 15 * 60_000;
