/**
 * Every BullMQ queue in the system. Producers (api/socket/cron) and processors (worker)
 * reference these names only, never string literals.
 */
export const QueueName = {
  /** Rewards: snapshot a closing leaderboard period into leaderboard_period_entries. */
  REWARD_PERIOD_SNAPSHOTS: 'reward-period-snapshots',
  // platform: S3 object deletions (avatars, rejected uploads, replaced images)
  STORAGE_CLEANUP: 'storage-cleanup',
  // platform: async xlsx report exports for every module
  REPORT_JOBS: 'report-jobs',
  // platform: file-manager subtree purge (S3 objects + rows)
  FILE_PURGE: 'file-purge',
  /** Identity: account anonymisation after the deletion grace period. */
  USERS: 'users',
  /** Daily words: sends due daily-word reminders through the Notifier (one dispatch run per minute). */
  DAILY_WORD_REMINDERS: 'daily-word-reminders',
  /** Live quiz: finalize an ended session (final ranks, report, Redis cleanup). */
  LIVE_QUIZ: 'live-quiz',
  /** Notifications: campaign runs (audience paging), campaign send batches, live-quiz event fan-in. */
  CAMPAIGNS: 'campaigns',
  /** Notifications: direct sends requested through the `Notifier` port (daily words, reminders, …). */
  NOTIFICATION_DELIVERIES: 'notification-deliveries',
  /** Notifications: quick (topic) notifications and their in-app inbox fan-out. */
  QUICK_NOTIFICATIONS: 'quick-notifications',
  /** Growth: referral rewards (registration, live-quiz join), short-link cleanup, anonymisation clean-up. */
  REFERRALS: 'referrals',
  /** Growth: WhatsApp (WATI) registration welcome messages and the staff registration alert. */
  WHATSAPP_WELCOME: 'whatsapp-welcome',
  /** Content: staff WhatsApp alert for a new prayer request (jobId per request). */
  CONTENT_PRAYER_ALERTS: 'content-prayer-alerts',
  /** Content: batched removal of Bible verses and verse marks after a language/version/book/verse delete. */
  CONTENT_BIBLE_PURGE: 'content-bible-purge',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];
