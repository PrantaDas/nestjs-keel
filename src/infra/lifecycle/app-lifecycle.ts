import { Injectable } from '@nestjs/common';

/** Time budget used when the app is closed without a shutdown deadline (tests, CLI). */
const NO_DEADLINE_BUDGET_MS = 10_000;

/**
 * Process lifecycle shared by readiness, the HTTP layer and the shutdown steps. Once a shutdown
 * starts, readiness answers 503 (load balancers stop routing here), HTTP responses carry
 * `Connection: close`, crons stop starting runs, and every step that waits (HTTP drain, cron runs,
 * BullMQ jobs) shares one deadline, so the whole sequence ends before the platform kills the process.
 */
@Injectable()
export class AppLifecycle {
  private deadline?: number;
  private draining = false;

  /** True from the first shutdown signal on. */
  get isShuttingDown(): boolean {
    return this.draining;
  }

  /** Starts the shutdown clock; later calls keep the first deadline. */
  beginShutdown(timeoutMs: number): void {
    if (this.draining) return;
    this.draining = true;
    this.deadline = performance.now() + timeoutMs;
  }

  /**
   * Milliseconds left before the shutdown deadline, minus `reserveMs` kept for the steps that come
   * after (closing MongoDB / Redis, flushing Sentry). Never negative.
   */
  remainingMs(reserveMs = 0): number {
    if (this.deadline === undefined) return NO_DEADLINE_BUDGET_MS;
    return Math.max(0, this.deadline - performance.now() - reserveMs);
  }
}
