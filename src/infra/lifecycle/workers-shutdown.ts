import { WorkerHost } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Worker } from 'bullmq';
import { AppLifecycle } from './app-lifecycle';

/** Kept for closing queues, MongoDB and Redis after the workers stop. */
const RESERVE_MS = 3000;

/**
 * Worker process shutdown, before any connection closes: every BullMQ worker stops taking jobs at
 * the same time and the jobs already running get until the shutdown deadline to finish
 * (`@nestjs/bullmq` would otherwise close the workers one queue module after another, while the
 * others keep fetching). Only `close()` is called: worker options stay with the queue policies
 * (queue-policies.ts). A job still running at the deadline is abandoned: its lock expires (the
 * policy's lockDuration) and BullMQ's stalled check puts it back in the queue for another worker,
 * so processors must stay idempotent.
 */
@Injectable()
export class WorkersShutdown implements BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkersShutdown.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly lifecycle: AppLifecycle,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const workers = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
      .map((host) => (host as unknown as { _worker?: Worker })._worker)
      .filter((worker): worker is Worker => Boolean(worker));
    if (!workers.length) return;

    const budgetMs = this.lifecycle.remainingMs(RESERVE_MS);
    this.logger.log({ workers: workers.length, budgetMs }, 'Stopping BullMQ workers: running jobs may finish');
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled(workers.map((worker) => worker.close())).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (finished) {
      this.logger.log('BullMQ workers stopped');
    } else {
      this.logger.warn(
        { budgetMs },
        'BullMQ jobs still running at the shutdown deadline: abandoned, BullMQ re-queues them once their lock expires',
      );
    }
  }
}
