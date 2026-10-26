import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UTC_POLICY } from '@/common/time/time-policy';
import { AppLifecycle } from '@/infra/lifecycle/app-lifecycle';
import { LockService } from '@/infra/redis/lock.service';
import { CronRuns } from './cron-runs';
import { LockedCron, resolveCronTimeZone } from './locked-cron.decorator';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn((callback: (scope: { setTag: jest.Mock }) => void) => callback({ setTag: jest.fn() })),
  captureException: jest.fn(),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
class ProbeCron {
  runs = 0;
  release?: () => void;

  @LockedCron('* * * * *', { name: 'spec-probe', lockTtlMs: 5 * 60_000, timeZone: UTC_POLICY.businessTimeZone })
  async tick(): Promise<void> {
    this.runs += 1;
    await new Promise<void>((resolve) => (this.release = resolve));
  }

  @LockedCron('* * * * *', { name: 'spec-failing', timeZone: UTC_POLICY.businessTimeZone })
  async failing(): Promise<void> {
    throw new Error('job failed');
  }
}

describe('@LockedCron', () => {
  let probe: ProbeCron;
  let runs: CronRuns;
  let lifecycle: AppLifecycle;
  let locks: { withLock: jest.Mock };

  beforeEach(async () => {
    locks = {
      withLock: jest.fn(async (_key: string, _options: unknown, task: () => Promise<unknown>) => ({
        acquired: true,
        value: await task(),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [ProbeCron, CronRuns, AppLifecycle, { provide: LockService, useValue: locks }],
    }).compile();
    probe = moduleRef.get(ProbeCron);
    runs = moduleRef.get(CronRuns);
    lifecycle = moduleRef.get(AppLifecycle);
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('caps the lock TTL at 30 s so a crashed run is recovered by the next tick', async () => {
    const run = probe.tick();
    await sleep(0);
    expect(locks.withLock).toHaveBeenCalledWith(
      'cron:spec-probe',
      { ttlMs: 30_000, onUnavailable: 'skip' },
      expect.any(Function),
    );
    probe.release!();
    await run;
  });

  it('skips the tick when the core Redis is unreachable, without running unlocked or throwing', async () => {
    locks.withLock.mockResolvedValue({ acquired: false, reason: 'unavailable', error: new Error('Command timed out') });
    await expect(probe.tick()).resolves.toBeUndefined();
    expect(probe.runs).toBe(0);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Cron run skipped: core Redis unreachable, the lock cannot be taken',
    );
  });

  it('never starts a second run in the same process while one is going (even if the lock was lost)', async () => {
    const first = probe.tick();
    await sleep(0);
    await probe.tick();
    expect(probe.runs).toBe(1);
    probe.release!();
    await first;
    const second = probe.tick();
    await sleep(0);
    expect(probe.runs).toBe(2);
    probe.release!();
    await second;
  });

  it('contains a failing run (logged and reported) instead of crashing', async () => {
    await expect(probe.failing()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.anything(), 'Cron run failed');
  });

  it('starts no new run once shutdown began', async () => {
    lifecycle.beginShutdown(5000);
    await probe.tick();
    expect(probe.runs).toBe(0);
    expect(locks.withLock).not.toHaveBeenCalled();
  });

  it('waits for runs in progress before the connections close', async () => {
    let finished = false;
    void runs.run('slow', async () => {
      await sleep(80);
      finished = true;
    });
    await runs.beforeApplicationShutdown();
    expect(finished).toBe(true);
    expect(await runs.run('late', async () => undefined)).toBe('stopping');
  });
});

describe('resolveCronTimeZone', () => {
  it('requires an explicit, valid zone: a cron without one fails to register', () => {
    expect(() => resolveCronTimeZone('no-zone', undefined)).toThrow(/must declare a valid IANA timeZone/);
    expect(() => resolveCronTimeZone('offset', '+04:00' as never)).toThrow(/must declare a valid IANA timeZone/);
  });

  it("resolves 'business' to BUSINESS_TIMEZONE and keeps explicit zones", () => {
    const previous = process.env.BUSINESS_TIMEZONE;
    process.env.BUSINESS_TIMEZONE = 'Asia/Dubai';
    try {
      expect(resolveCronTimeZone('daily', 'business')).toBe('Asia/Dubai');
      expect(resolveCronTimeZone('interval', 'UTC')).toBe('UTC');
    } finally {
      process.env.BUSINESS_TIMEZONE = previous;
    }
  });
});
