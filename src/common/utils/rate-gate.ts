/**
 * Lets one event per key through per window and counts the rest, so an outage (thousands of
 * identical failures per minute) produces one log line or Sentry event per minute, with the
 * number of suppressed repeats, instead of a flood. Monotonic clock: immune to wall-clock jumps.
 */
export class RateGate {
  private readonly windows = new Map<string, { openedAt: number; suppressed: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * True when the event should be reported. `suppressed` is how many events of this key were
   * dropped since the previous report (attach it to the log line).
   */
  pass(key: string): { pass: boolean; suppressed: number } {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || now - window.openedAt >= this.windowMs) {
      this.windows.set(key, { openedAt: now, suppressed: 0 });
      return { pass: true, suppressed: window?.suppressed ?? 0 };
    }
    window.suppressed += 1;
    return { pass: false, suppressed: window.suppressed };
  }

  /** Forgets a key, so the next event passes (e.g. once the dependency recovered). */
  reset(key: string): void {
    this.windows.delete(key);
  }
}
