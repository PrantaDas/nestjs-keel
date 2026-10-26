import { Logger, type INestApplicationContext } from '@nestjs/common';
import { AppLifecycle } from '@/infra/lifecycle/app-lifecycle';
import { httpTrafficOf } from './http-app';
import type { HttpTraffic } from './http-traffic';
import { GracefulShutdown } from './shutdown';

jest.mock('./http-app', () => ({ httpTrafficOf: jest.fn() }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GracefulShutdown', () => {
  let steps: string[];
  let lifecycle: AppLifecycle;
  let exit: jest.Mock;
  let flush: jest.Mock;
  let closeApp: () => Promise<void>;
  let server: { listening: boolean; close: jest.Mock; closeIdleConnections: jest.Mock };
  let traffic: { beginDrain: jest.Mock; drained: jest.Mock; answerRemaining: jest.Mock };

  const app = () =>
    ({
      get: () => lifecycle,
      getHttpServer: () => server,
      close: () => closeApp(),
    }) as unknown as INestApplicationContext;

  const create = (timeoutMs = 2000, drainDelayMs = 0) =>
    new GracefulShutdown(app(), { label: 'API', timeoutMs, drainDelayMs }, { exit, flush });

  beforeEach(() => {
    steps = [];
    lifecycle = new AppLifecycle();
    jest.spyOn(lifecycle, 'beginShutdown').mockImplementation(function (this: AppLifecycle, ms: number) {
      steps.push('readiness 503');
      AppLifecycle.prototype.beginShutdown.call(this, ms);
    });
    exit = jest.fn((code: number) => steps.push(`exit ${code}`));
    flush = jest.fn(async () => steps.push('sentry flush'));
    closeApp = async () => {
      steps.push('app.close (workers, crons, sockets, then Mongo/Redis)');
    };
    server = {
      listening: true,
      close: jest.fn(() => steps.push('listener closed')),
      closeIdleConnections: jest.fn(() => steps.push('idle keep-alive closed')),
    };
    traffic = {
      beginDrain: jest.fn(() => steps.push('Connection: close')),
      drained: jest.fn(async () => {
        steps.push('in-flight requests finished');
        return true;
      }),
      answerRemaining: jest.fn(() => 0),
    };
    jest.mocked(httpTrafficOf).mockReturnValue(traffic as unknown as HttpTraffic);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('drains HTTP before closing the app, then flushes Sentry and exits 0', async () => {
    await create().shutdown('SIGTERM');
    expect(steps).toEqual([
      'readiness 503',
      'Connection: close',
      'listener closed',
      'idle keep-alive closed',
      'in-flight requests finished',
      'app.close (workers, crons, sockets, then Mongo/Redis)',
      'sentry flush',
      'exit 0',
    ]);
    expect(lifecycle.isShuttingDown).toBe(true);
  });

  it('waits the drain delay with readiness already 503 before closing the listener', async () => {
    const started = performance.now();
    const run = create(2000, 120).shutdown('SIGTERM');
    await sleep(60);
    expect(lifecycle.isShuttingDown).toBe(true);
    expect(server.close).not.toHaveBeenCalled();
    await run;
    expect(performance.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('answers requests still running at the drain deadline with 503 and carries on', async () => {
    traffic.drained.mockResolvedValue(false);
    traffic.answerRemaining.mockReturnValue(2);
    await create().shutdown('SIGTERM');
    expect(traffic.answerRemaining).toHaveBeenCalled();
    expect(steps.at(-1)).toBe('exit 0');
  });

  it('exits 1 at the deadline when a step hangs', async () => {
    closeApp = () => new Promise(() => undefined);
    void create(150).shutdown('SIGTERM');
    await sleep(400);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when a step fails, and with the requested code after a fatal error', async () => {
    closeApp = () => Promise.reject(new Error('close failed'));
    await create().shutdown('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(1);

    closeApp = async () => undefined;
    exit.mockClear();
    await create().shutdown('uncaughtException', 1);
    expect(exit).toHaveBeenLastCalledWith(1);
  });

  it('runs once for repeated calls; a second signal exits at once', async () => {
    let release!: () => void;
    let closes = 0;
    closeApp = () => {
      closes += 1;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const shutdown = create().install(['SIGUSR2']);
    try {
      process.emit('SIGUSR2', 'SIGUSR2');
      await sleep(10);
      void shutdown.shutdown('again');
      expect(closes).toBe(1);
      process.emit('SIGUSR2', 'SIGUSR2');
      expect(exit).toHaveBeenCalledWith(1);
      release();
      await shutdown.shutdown('again');
      expect(closes).toBe(1);
    } finally {
      shutdown.uninstall();
    }
  });

  it('skips the HTTP drain for processes without a listener (worker, cron)', async () => {
    jest.mocked(httpTrafficOf).mockReturnValue(undefined);
    await create().shutdown('SIGTERM');
    expect(steps).toEqual([
      'readiness 503',
      'app.close (workers, crons, sockets, then Mongo/Redis)',
      'sentry flush',
      'exit 0',
    ]);
  });
});
