/**
 * Shutdown hook of the OpenTelemetry SDK, kept apart from `instrument.ts` so the shutdown code can
 * flush telemetry without importing the SDK (it is only loaded when `OTEL_ENABLED=true`).
 */
let flushTelemetry: (() => Promise<void>) | undefined;

export function onTelemetryShutdown(flush: () => Promise<void>): void {
  flushTelemetry = flush;
}

/** Flushes pending spans and metrics; a no-op when telemetry is off. Never throws. */
export async function shutdownTelemetry(): Promise<void> {
  await flushTelemetry?.().catch(() => undefined);
}
