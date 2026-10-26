export interface BackoffOptions {
  /** Delay before the first retry (attempt 1), before jitter. */
  baseMs: number;
  /** Upper bound of any single delay. */
  maxMs: number;
  /**
   * Share of the delay that is randomised (0–1). 1 = "full jitter" (0…d), 0.5 = d/2…d.
   * Spreads retries of many callers so they do not hit a recovering provider together.
   */
  jitter: number;
}

/**
 * Exponential backoff with jitter: attempt n (1-based) waits `min(maxMs, baseMs·2^(n-1))`, of
 * which a `jitter` share is random. Always within [d·(1−jitter), d].
 */
export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(exponent, 30));
  const jitter = Math.min(1, Math.max(0, options.jitter));
  const floor = ceiling * (1 - jitter);
  return Math.round(floor + random() * (ceiling - floor));
}

export interface RetryOptions extends BackoffOptions {
  /** Retries after the first attempt (0 = no retry). */
  retries: number;
  /** Whether this error is worth another attempt (e.g. transient and the call is idempotent). */
  shouldRetry: (error: unknown) => boolean;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * In-process retry for IDEMPOTENT calls only (reads, PUT/DELETE of the same key). Sends that are
 * not idempotent are never retried here: their jobs are, behind a claim.
 */
export async function retryWithBackoff<T>(call: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      if (attempt > options.retries || !options.shouldRetry(error)) throw error;
      await sleep(backoffDelay(attempt, options, options.random));
    }
  }
}
