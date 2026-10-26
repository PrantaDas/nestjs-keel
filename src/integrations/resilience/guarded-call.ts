import { CallVerdict, defaultVerdict, integrationBreakers } from './circuit-breaker';
import { withDeadline } from './deadline';
import { toIntegrationError } from './failure';

/**
 * Display name (used in logs and error classification) → breaker key (env overrides, logs).
 * Two clients of the same provider share one breaker. Add a line when you add an integration.
 */
export const INTEGRATION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'Firebase Cloud Messaging': 'fcm',
  'Web Push': 'webpush',
  'AWS S3': 's3',
  SMTP: 'smtp',
  'Twilio SMS': 'twilio',
  Stripe: 'stripe',
});

/** Breaker key of an integration display name (unknown names: lower-case slug). */
export function breakerKey(integration: string): string {
  return (
    INTEGRATION_KEYS[integration] ??
    integration
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

export interface GuardOptions {
  /** Caller released after this long (DeadlineExceededError → transient, ambiguous timeout). */
  deadlineMs?: number;
  /** Overrides how an error counts for the breaker (default: transient = failure). */
  verdict?: (error: unknown) => CallVerdict;
}

/**
 * One outbound call through the integration's circuit breaker, with an optional deadline, and any
 * SDK error turned into a classified IntegrationCallException (domain exceptions pass through).
 */
export async function guardedCall<T>(
  integration: string,
  call: () => Promise<T>,
  options: GuardOptions = {},
): Promise<T> {
  try {
    return await integrationBreakers.execute(
      breakerKey(integration),
      () => (options.deadlineMs ? withDeadline(call(), options.deadlineMs) : call()),
      options.verdict ?? defaultVerdict,
    );
  } catch (error) {
    throw toIntegrationError(integration, error);
  }
}
