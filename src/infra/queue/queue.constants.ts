/**
 * Every BullMQ queue in the system. Producers (api / graphql / socket / cron) and processors
 * (worker) reference these names only, never string literals. Adding one here without a row in
 * `QUEUE_POLICIES` fails a unit test. Deterministic job ids (`jobId`) may not contain `:` (BullMQ 6).
 */
export const QueueName = {
  /** Identity: deliver a one-time code by SMS or e-mail (claimed once per code). */
  OTP_DELIVERY: 'otp-delivery',
  /** Identity: anonymise accounts whose deletion grace period is over. */
  ACCOUNT_DELETION: 'account-deletion',
  /** Notifications: push + inbox + e-mail deliveries requested through the `Notifier` port. */
  NOTIFICATIONS: 'notifications',
  /** Examples (notes): reminder pushes and background work for the example module. */
  NOTES: 'notes',
  /** Payments: Stripe webhook events, handled outside the webhook request. */
  STRIPE_EVENTS: 'stripe-events',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];
