import * as Sentry from '@sentry/nestjs';

/**
 * Must come right after the telemetry import in every entry point so Sentry can instrument modules
 * as they load. Reads process.env directly because it runs before the Nest config module.
 * No DSN → Sentry stays disabled (local dev, tests). Events carry release and environment; the
 * request id is attached per event by the exception filters.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.RELEASE || undefined,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  // `enableOpenTelemetrySetup` stays off (the default): with OTEL_ENABLED the app's own SDK owns the
  // global tracer provider (infra/telemetry/instrument.ts) and Sentry does not compete with it.
  // Uncaught exceptions and unhandled rejections are reported (once) and turned into a graceful
  // exit by src/bootstrap/process-handlers.ts; Sentry's own handlers would report them twice.
  integrations: (defaults) =>
    defaults.filter((integration) => !['OnUncaughtException', 'OnUnhandledRejection'].includes(integration.name)),
  // No IPs, cookies, auth headers or request bodies leave the server; the user id is set explicitly.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
    httpHeaders: { request: { deny: ['authorization', 'cookie', 'x-api-key', 'stripe-signature'] } },
    stackFrameVariables: false,
  },
});
