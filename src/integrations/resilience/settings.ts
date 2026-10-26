import type { ConfigType } from '@nestjs/config';
import type { resilienceConfig } from '@/config/configuration';
import { BreakerSettings, DEFAULT_BREAKER_SETTINGS, parseBreakerOverrides } from './circuit-breaker';

/** Timeouts (ms) of every outbound call. Defaults apply when a value is missing (unit tests). */
export interface IntegrationTimeouts {
  /** REST calls through `fetchJson` (any plain HTTP provider you add). */
  http: number;
  /** One FCM call, firebase-admin's internal retries included (caller released after it). */
  fcm: number;
  /** One Web Push delivery request to a browser's push service. */
  webpush: number;
  /** One SMTP send (socket timeout; the caller is released shortly after). */
  smtp: number;
  /** S3 socket inactivity per request (the SDK retries up to 3 times). */
  s3: number;
  /** Twilio REST request. */
  twilio: number;
  /** One Stripe API request (the SDK's own network retries included). */
  stripe: number;
}

export const DEFAULT_TIMEOUTS: IntegrationTimeouts = Object.freeze({
  http: 10_000,
  fcm: 30_000,
  webpush: 10_000,
  smtp: 20_000,
  s3: 30_000,
  twilio: 15_000,
  stripe: 20_000,
});

type Config = { [K in keyof ConfigType<typeof resilienceConfig>]?: Partial<ConfigType<typeof resilienceConfig>[K]> };

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export function timeoutsFrom(config: Config | undefined): IntegrationTimeouts {
  const t = config?.timeouts;
  return {
    http: positive(t?.http, DEFAULT_TIMEOUTS.http),
    fcm: positive(t?.fcm, DEFAULT_TIMEOUTS.fcm),
    webpush: positive(t?.webpush, DEFAULT_TIMEOUTS.webpush),
    smtp: positive(t?.smtp, DEFAULT_TIMEOUTS.smtp),
    s3: positive(t?.s3, DEFAULT_TIMEOUTS.s3),
    twilio: positive(t?.twilio, DEFAULT_TIMEOUTS.twilio),
    stripe: positive(t?.stripe, DEFAULT_TIMEOUTS.stripe),
  };
}

export function breakerSettingsFrom(config: Config | undefined): BreakerSettings {
  const b = config?.breaker;
  if (!b) return DEFAULT_BREAKER_SETTINGS;
  return {
    enabled: b.enabled ?? true,
    failureThreshold: positive(b.failureThreshold, DEFAULT_BREAKER_SETTINGS.failureThreshold),
    openMs: positive(b.openMs, DEFAULT_BREAKER_SETTINGS.openMs),
    overrides: parseBreakerOverrides(b.overrides ?? ''),
  };
}

/** Process-wide default for `fetchJson` callers that pass no timeout (set from env at start). */
let httpTimeoutMs = DEFAULT_TIMEOUTS.http;

export function defaultHttpTimeoutMs(): number {
  return httpTimeoutMs;
}

export function setDefaultHttpTimeoutMs(value: number): void {
  httpTimeoutMs = positive(value, DEFAULT_TIMEOUTS.http);
}
