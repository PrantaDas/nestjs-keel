import { backoffDelay, retryWithBackoff } from './backoff';
import { DeadlineExceededError, withDeadline } from './deadline';

const OPTIONS = { baseMs: 100, maxMs: 1_000, jitter: 0.5 };

describe('backoffDelay', () => {
  it('doubles per attempt up to the cap (no jitter)', () => {
    const exact = { ...OPTIONS, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, exact))).toEqual([100, 200, 400, 800, 1_000, 1_000]);
  });

  it('stays within [d·(1−jitter), d] for every random value', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const ceiling = Math.min(1_000, 100 * 2 ** (attempt - 1));
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const delay = backoffDelay(attempt, OPTIONS, () => r);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.5));
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('full jitter spans 0…d; out-of-range jitter is clamped; huge attempts do not overflow', () => {
    expect(backoffDelay(3, { ...OPTIONS, jitter: 1 }, () => 0)).toBe(0);
    expect(backoffDelay(3, { ...OPTIONS, jitter: 1 }, () => 0.999999)).toBe(400);
    expect(backoffDelay(2, { ...OPTIONS, jitter: 7 }, () => 0)).toBe(0);
    expect(backoffDelay(2, { ...OPTIONS, jitter: -1 }, () => 0)).toBe(200);
    expect(backoffDelay(10_000, OPTIONS, () => 1)).toBe(1_000);
  });
});

describe('retryWithBackoff', () => {
  it('retries retryable errors with growing delays, then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await retryWithBackoff(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new Error('flaky');
        return 'ok';
      },
      { ...OPTIONS, jitter: 0, retries: 3, shouldRetry: () => true, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('stops at once for a non-retryable error, and after the last retry', async () => {
    let calls = 0;
    const permanent = retryWithBackoff(
      async () => {
        calls += 1;
        throw new Error('400');
      },
      { ...OPTIONS, retries: 5, shouldRetry: () => false, sleep: async () => undefined },
    );
    await expect(permanent).rejects.toThrow('400');
    expect(calls).toBe(1);

    calls = 0;
    const exhausted = retryWithBackoff(
      async () => {
        calls += 1;
        throw new Error('503');
      },
      { ...OPTIONS, retries: 2, shouldRetry: () => true, sleep: async () => undefined },
    );
    await expect(exhausted).rejects.toThrow('503');
    expect(calls).toBe(3);
  });
});

describe('withDeadline', () => {
  it('releases the caller after the deadline with a timeout error', async () => {
    const never = new Promise<string>(() => undefined);
    const error = await withDeadline(never, 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ name: 'TimeoutError', timeoutMs: 20 });
  });

  it('returns the result when the call is faster, and passes no deadline through', async () => {
    await expect(withDeadline(Promise.resolve('fast'), 1_000)).resolves.toBe('fast');
    await expect(withDeadline(Promise.resolve('no deadline'), 0)).resolves.toBe('no deadline');
  });
});
