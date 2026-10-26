import { INestApplicationContext, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Server } from 'node:http';
import { AppLifecycle } from '@/infra/lifecycle/app-lifecycle';
import { shutdownTelemetry } from '@/infra/telemetry/telemetry';
import { httpTrafficOf } from './http-app';

/** Kept after the HTTP drain for the Nest shutdown hooks (sockets, queues, MongoDB, Redis). */
const HTTP_DRAIN_RESERVE_MS = 5000;
const SENTRY_FLUSH_MS = 2000;

export interface ShutdownOptions {
  /** Process label for logs: API, GraphQL, Socket, Worker, Cron. */
  label: string;
  /** Hard deadline (`SHUTDOWN_TIMEOUT_MS`), below the platform's kill timeout. */
  timeoutMs: number;
  /** Readiness answers 503 this long before the listener closes (`SHUTDOWN_DRAIN_DELAY_MS`). */
  drainDelayMs: number;
}

export interface ShutdownDeps {
  exit: (code: number) => void;
  flush: (timeoutMs: number) => Promise<unknown>;
}

const defaultDeps: ShutdownDeps = {
  exit: (code) => process.exit(code),
  // Sentry events and OpenTelemetry spans/metrics leave before the process does.
  flush: (timeoutMs) => Promise.all([Sentry.flush(timeoutMs), shutdownTelemetry()]),
};

/**
 * Graceful shutdown on SIGTERM / SIGINT (Kubernetes, ECS and Docker send SIGTERM, Ctrl-C sends SIGINT), also used
 * after a fatal process error. Nest's `enableShutdownHooks` is not used: it has no deadline and
 * re-raises the signal. Order:
 *  1. readiness turns 503 (load balancers stop routing here), answers carry `Connection: close`;
 *  2. optional drain delay, then the HTTP listener closes (no new connections, idle keep-alive
 *     sockets closed) and in-flight requests finish; any still running near the deadline get 503;
 *  3. `app.close()`, the Nest lifecycle: BullMQ workers stop and running jobs finish, cron runs
 *     finish and release their locks (`beforeApplicationShutdown`), sockets close so clients
 *     reconnect elsewhere (dispose), then queues, MongoDB and Redis close (`onApplicationShutdown`);
 *  4. Sentry is flushed and the process exits (0, or 1 after a fatal error or a failed step).
 * Everything shares one deadline (`SHUTDOWN_TIMEOUT_MS`); past it the process exits with 1 anyway.
 * A second signal exits at once.
 */
export class GracefulShutdown {
  private readonly logger = new Logger('Shutdown');
  private running?: Promise<void>;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly app: INestApplicationContext,
    private readonly options: ShutdownOptions,
    private readonly deps: ShutdownDeps = defaultDeps,
  ) {}

  /** Starts listening for termination signals. */
  install(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): this {
    for (const signal of signals) {
      const handler = () => this.onSignal(signal);
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
    return this;
  }

  uninstall(): void {
    this.handlers.forEach((handler, signal) => process.off(signal, handler));
    this.handlers.clear();
  }

  /** Runs the sequence once; later calls return the same promise. */
  shutdown(reason: string, exitCode = 0): Promise<void> {
    this.running ??= this.run(reason, exitCode);
    return this.running;
  }

  private onSignal(signal: NodeJS.Signals): void {
    if (this.running) {
      this.logger.warn({ signal }, 'Second termination signal: exiting now');
      this.deps.exit(1);
      return;
    }
    void this.shutdown(signal);
  }

  private async run(reason: string, exitCode: number): Promise<void> {
    const { label, timeoutMs, drainDelayMs } = this.options;
    const lifecycle = this.lifecycle();
    lifecycle?.beginShutdown(timeoutMs);
    this.logger.log({ reason, timeoutMs }, `${label} shutting down`);

    let forced = false;
    const deadline = setTimeout(() => {
      forced = true;
      this.logger.error({ reason, timeoutMs }, `${label} shutdown deadline reached: exiting now`);
      void this.deps
        .flush(500)
        .catch(() => undefined)
        .finally(() => this.deps.exit(1));
    }, timeoutMs);
    deadline.unref();

    let code = exitCode;
    try {
      await this.drainHttp(drainDelayMs, () => lifecycle?.remainingMs(HTTP_DRAIN_RESERVE_MS) ?? timeoutMs);
      await this.app.close();
      this.logger.log(`${label} shut down cleanly`);
    } catch (err) {
      this.logger.error({ err }, `${label} shutdown step failed`);
      code = 1;
    }
    clearTimeout(deadline);
    if (forced) return;
    await this.deps.flush(SENTRY_FLUSH_MS).catch(() => undefined);
    this.deps.exit(code);
  }

  private async drainHttp(delayMs: number, budgetMs: () => number): Promise<void> {
    const traffic = httpTrafficOf(this.app);
    const server = this.httpServer();
    if (!traffic || !server) return;
    traffic.beginDrain();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    server.close();
    server.closeIdleConnections();
    if (await traffic.drained(budgetMs())) return;
    const answered = traffic.answerRemaining();
    this.logger.warn({ answered }, 'HTTP requests still running at the drain deadline: answered 503');
  }

  private httpServer(): Server | undefined {
    const app = this.app as INestApplicationContext & { getHttpServer?: () => Server };
    const server = typeof app.getHttpServer === 'function' ? app.getHttpServer() : undefined;
    return server?.listening ? server : undefined;
  }

  private lifecycle(): AppLifecycle | undefined {
    try {
      return this.app.get(AppLifecycle, { strict: false });
    } catch {
      return undefined;
    }
  }
}
