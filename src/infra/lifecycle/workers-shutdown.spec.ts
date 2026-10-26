import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import { AppLifecycle } from './app-lifecycle';
import { WorkersShutdown } from './workers-shutdown';

class Processor extends WorkerHost {
  constructor(
    closeAfterMs: number,
    readonly closed: string[],
    name: string,
  ) {
    super();
    (this as unknown as { _worker: unknown })._worker = {
      close: () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            closed.push(name);
            resolve();
          }, closeAfterMs);
          timer.unref();
        }),
    };
  }
  process(): Promise<unknown> {
    return Promise.resolve();
  }
}

const discoveryOf = (instances: unknown[]) =>
  ({ getProviders: () => instances.map((instance) => ({ instance })) }) as unknown as DiscoveryService;

describe('WorkersShutdown', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('closes every worker at the same time and waits for their running jobs', async () => {
    const closed: string[] = [];
    const lifecycle = new AppLifecycle();
    lifecycle.beginShutdown(10_000);
    const started = performance.now();
    await new WorkersShutdown(
      discoveryOf([new Processor(80, closed, 'a'), new Processor(80, closed, 'b'), { notAWorker: true }]),
      lifecycle,
    ).beforeApplicationShutdown();
    expect(closed.sort()).toEqual(['a', 'b']);
    // concurrent, not one queue after another
    expect(performance.now() - started).toBeLessThan(150);
  });

  it('stops waiting at the shutdown deadline (jobs are re-queued once their lock expires)', async () => {
    const lifecycle = new AppLifecycle();
    lifecycle.beginShutdown(3100); // 100 ms left after the 3 s reserve
    const started = performance.now();
    await new WorkersShutdown(discoveryOf([new Processor(5000, [], 'slow')]), lifecycle).beforeApplicationShutdown();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('does nothing in processes without workers', async () => {
    await expect(
      new WorkersShutdown(discoveryOf([{}]), new AppLifecycle()).beforeApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});
