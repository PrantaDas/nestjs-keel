import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { GracefulShutdown, ShutdownDeps } from './shutdown';

const SENTRY_FLUSH_MS = 2000;

let activeShutdown: GracefulShutdown | undefined;
let failing = false;

/** The shutdown a fatal error should run (set once the app exists). */
export function setFatalShutdown(shutdown: GracefulShutdown | undefined): void {
  activeShutdown = shutdown;
}

const defaultDeps: ShutdownDeps = {
  exit: (code) => process.exit(code),
  flush: (timeoutMs) => Sentry.flush(timeoutMs),
};

/**
 * Last line of defence for errors nothing else caught (an unhandled rejection or an uncaught
 * exception): the process state can no longer be trusted, so it is logged (fatal), sent to Sentry,
 * and the process exits with 1 after a graceful shutdown bounded by `SHUTDOWN_TIMEOUT_MS` (or at
 * once while booting). The orchestrator (Kubernetes, ECS, Docker restart policy) restarts it. Nothing is swallowed and nothing keeps
 * running half-broken. Sentry's own handlers for these events are disabled (instrument.ts) so each
 * error is reported once.
 */
export function handleFatalError(error: unknown, origin: string, deps: ShutdownDeps = defaultDeps): void {
  const logger = new Logger('Process');
  if (failing) {
    // Another fatal error while shutting down: report it, the exit is already on its way.
    logger.fatal({ err: error, origin }, 'Another fatal error during the fatal shutdown');
    Sentry.captureException(error, { level: 'fatal', tags: { origin } });
    return;
  }
  failing = true;
  logger.fatal({ err: error, origin }, `Fatal ${origin}: exiting`);
  Sentry.captureException(error, { level: 'fatal', tags: { origin, handled: 'no' } });

  if (activeShutdown) {
    void activeShutdown.shutdown(origin, 1);
    return;
  }
  void deps
    .flush(SENTRY_FLUSH_MS)
    .catch(() => undefined)
    .finally(() => deps.exit(1));
}

/** Installs the fatal handlers. First call in every entry point (after Sentry's instrument import). */
export function registerProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => handleFatalError(reason, 'unhandledRejection'));
  process.on('uncaughtException', (error, origin) => handleFatalError(error, origin));
}

/** For tests only: forget the fatal state between cases. */
export function resetFatalStateForTests(): void {
  failing = false;
  activeShutdown = undefined;
}
