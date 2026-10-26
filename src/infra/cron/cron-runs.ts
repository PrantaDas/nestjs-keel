import { BeforeApplicationShutdown, Global, Injectable, Logger, Module, Optional } from '@nestjs/common';
import { AppLifecycle } from '@/infra/lifecycle/app-lifecycle';

/** Kept for closing MongoDB and Redis after the runs end. */
const RESERVE_MS = 3000;

/**
 * In-process registry of `@LockedCron` runs:
 * - one run per cron at a time in this process, even if the Redis lock was lost meanwhile;
 * - no new run once shutdown started;
 * - on shutdown, runs in progress get until the shutdown deadline to finish (and release their
 *   lock) before MongoDB and Redis close. A run still going at the deadline is cut off with the
 *   process; its lock expires within its TTL and the next tick after the restart runs again.
 */
@Injectable()
export class CronRuns implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CronRuns.name);
  private readonly running = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(@Optional() private readonly lifecycle?: AppLifecycle) {}

  /** Runs `run` unless shutdown started or the same cron is already running here. */
  async run(name: string, run: () => Promise<void>): Promise<'ran' | 'overlap' | 'stopping'> {
    if (this.stopping || this.lifecycle?.isShuttingDown) return 'stopping';
    if (this.running.has(name)) return 'overlap';
    const promise = run().finally(() => this.running.delete(name));
    this.running.set(name, promise);
    await promise;
    return 'ran';
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (!this.running.size) return;
    const names = [...this.running.keys()];
    const budgetMs = this.lifecycle?.remainingMs(RESERVE_MS) ?? 10_000;
    this.logger.log({ crons: names, budgetMs }, 'Waiting for cron runs in progress');
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled(this.running.values()).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      this.logger.warn(
        { crons: [...this.running.keys()] },
        'Cron runs still going at the shutdown deadline: their locks expire within their TTL',
      );
    }
  }
}

@Global()
@Module({ providers: [CronRuns], exports: [CronRuns] })
export class CronInfraModule {}
