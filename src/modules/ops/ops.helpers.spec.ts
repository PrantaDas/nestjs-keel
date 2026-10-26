import type { Job } from 'bullmq';
import { countInWindow, toFailedJobView } from './ops.helpers';

const MIN = 60_000;

describe('countInWindow (BullMQ per-minute metrics)', () => {
  const now = 1_000 * MIN + 30_000; // minute 1000

  it('is 0 before anything was recorded', () => {
    expect(countInWindow({ meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [] }, now)).toBe(0);
  });

  it('counts the jobs since the last roll-over plus the data points inside the window', () => {
    // Last roll-over at minute 990: 2 jobs since; data[i] = minute 989 − i.
    const metrics = { meta: { count: 12, prevTS: 990 * MIN, prevCount: 10 }, data: [1, 2, 3, 4] };
    expect(countInWindow(metrics, now)).toBe(2 + 1 + 2 + 3 + 4);
    // A 12-minute window (minutes 989…1000) only reaches data[0].
    expect(countInWindow(metrics, now, 12)).toBe(2 + 1);
    // A 10-minute window (991…1000) contains neither.
    expect(countInWindow(metrics, now, 10)).toBe(0);
  });

  it('ignores data older than 24 h', () => {
    const data = Array.from({ length: 2_880 }, () => 1);
    const metrics = { meta: { count: 5, prevTS: now - 60 * MIN, prevCount: 5 }, data };
    expect(countInWindow(metrics, now)).toBe(24 * 60 - 60 - 1);
    expect(countInWindow({ ...metrics, meta: { count: 9, prevTS: now - 25 * 60 * MIN, prevCount: 1 } }, now)).toBe(0);
  });
});

describe('toFailedJobView', () => {
  it('exposes what ops needs, never the payload, with secrets redacted', () => {
    const job = {
      id: 'notify-1',
      name: 'generate',
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: { email: 'someone@example.com', token: 'secret' },
      failedReason: 'HTTP 401: {"token":"abc123"} Bearer xyz',
      timestamp: 1_700_000_000_000,
      processedOn: 1_700_000_001_000,
      finishedOn: 1_700_000_002_000,
    } as unknown as Job;
    const view = toFailedJobView(job);
    expect(view).toEqual({
      id: 'notify-1',
      name: 'generate',
      attemptsMade: 3,
      maxAttempts: 3,
      failedReason: 'HTTP 401: {"token":"***"} Bearer ***',
      createdAt: new Date(1_700_000_000_000),
      processedAt: new Date(1_700_000_001_000),
      failedAt: new Date(1_700_000_002_000),
    });
    expect(JSON.stringify(view)).not.toContain('someone@example.com');
  });

  it('copes with missing fields', () => {
    const view = toFailedJobView({ id: 7, name: 'x', attemptsMade: 0, opts: {} } as unknown as Job);
    expect(view).toMatchObject({ id: '7', maxAttempts: 1, failedReason: 'unknown', processedAt: null });
  });
});
