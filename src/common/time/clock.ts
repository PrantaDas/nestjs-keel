/**
 * Source of "now". Inject it (or TimeService) instead of calling `new Date()` / `Date.now()`,
 * so tests can freeze time at any boundary. `performance.now()` stays allowed for durations.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Test clock: frozen until moved. */
export class FixedClock extends Clock {
  private current: Date;

  constructor(start: Date | string) {
    super();
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * A clock that keeps ticking from a chosen point in time (the seed writes "last month's" history
 * through the real services with it). `travelTo` jumps; time then passes at the normal rate, so
 * records written in sequence still get increasing timestamps.
 */
export class MovableClock extends Clock {
  private offsetMs = 0;

  constructor(private readonly base: Clock = new SystemClock()) {
    super();
  }

  now(): Date {
    return new Date(this.base.now().getTime() + this.offsetMs);
  }

  travelTo(instant: Date): void {
    this.offsetMs = instant.getTime() - this.base.now().getTime();
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

/** For code outside Nest DI (middleware, CLI). Prefer injecting Clock everywhere else. */
export const systemClock = new SystemClock();
