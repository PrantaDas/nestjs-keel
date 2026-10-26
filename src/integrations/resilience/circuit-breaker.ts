import { Logger } from '@nestjs/common';
import { classifyFailure, IntegrationUnavailableException } from './failure';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerPolicy {
  /** Consecutive transient failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one probe call is let through. */
  openMs: number;
}

export interface BreakerSettings extends BreakerPolicy {
  enabled: boolean;
  /** Per integration key (`fcm`, `smtp`, …) overrides of the defaults. */
  overrides: Readonly<Record<string, Partial<BreakerPolicy>>>;
}

export const DEFAULT_BREAKER_SETTINGS: BreakerSettings = Object.freeze({
  enabled: true,
  failureThreshold: 5,
  openMs: 30_000,
  overrides: {},
});

/** What an outcome means for the circuit: a transient provider failure, a healthy answer, or neither. */
export type CallVerdict = 'failure' | 'success' | 'ignore';

/** Default verdict: transient → failure; a permanent answer proves the provider is up; missing config is local. */
export function defaultVerdict(error: unknown): CallVerdict {
  const failure = classifyFailure(error);
  if (failure.reason === 'not_configured' || failure.reason === 'circuit_open') return 'ignore';
  return failure.transient ? 'failure' : 'success';
}

export interface BreakerLogger {
  warn(message: object, text: string): void;
  log(message: object, text: string): void;
}

export interface BreakerSnapshot {
  integration: string;
  state: BreakerState;
  consecutiveFailures: number;
  /** Milliseconds until a probe is allowed (open circuits only). */
  retryInMs: number | null;
}

/**
 * Per-integration circuit breaker (one instance per process and integration):
 *
 *   closed ──N consecutive transient failures──▶ open ──openMs──▶ half_open ──probe ok──▶ closed
 *                                                  ▲                  │
 *                                                  └──probe failed────┘
 *
 * While open every call fails fast with IntegrationUnavailableException (503, retryable) without
 * touching the provider. In half_open exactly one call (the probe) goes through; the others keep
 * failing fast until it settles. Outcomes of calls that started in an earlier state are ignored.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  /** Bumped on every transition, so late results of old calls cannot flip the new state. */
  private generation = 0;

  constructor(
    readonly integration: string,
    private policy: BreakerPolicy,
    private readonly clock: () => number = () => performance.now(),
    private readonly logger: BreakerLogger = new Logger('CircuitBreaker'),
  ) {}

  setPolicy(policy: BreakerPolicy): void {
    this.policy = policy;
  }

  async execute<T>(call: () => Promise<T>, verdict: (error: unknown) => CallVerdict = defaultVerdict): Promise<T> {
    const ticket = this.admit();
    let result: T;
    try {
      result = await call();
    } catch (error) {
      this.settle(ticket, verdict(error));
      throw error;
    }
    this.settle(ticket, 'success');
    return result;
  }

  snapshot(): BreakerSnapshot {
    this.refresh();
    return {
      integration: this.integration,
      state: this.state,
      consecutiveFailures: this.failures,
      retryInMs:
        this.state === 'open' ? Math.max(0, Math.ceil(this.openedAt + this.policy.openMs - this.clock())) : null,
    };
  }

  /** Back to closed (tests, or an operator after fixing credentials). */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.probeInFlight = false;
    this.generation += 1;
  }

  private admit(): { generation: number; probe: boolean } {
    this.refresh();
    if (this.state === 'open' || (this.state === 'half_open' && this.probeInFlight)) {
      const retryAfterMs =
        this.state === 'open' ? Math.max(0, Math.ceil(this.openedAt + this.policy.openMs - this.clock())) : 0;
      throw new IntegrationUnavailableException(this.integration, retryAfterMs);
    }
    if (this.state === 'half_open') {
      this.probeInFlight = true;
      return { generation: this.generation, probe: true };
    }
    return { generation: this.generation, probe: false };
  }

  private settle(ticket: { generation: number; probe: boolean }, verdict: CallVerdict): void {
    if (ticket.generation !== this.generation) return;
    if (ticket.probe) {
      this.probeInFlight = false;
      if (verdict === 'failure') this.open('Integration circuit re-opened: probe failed');
      else this.close();
      return;
    }
    if (verdict === 'success') {
      this.failures = 0;
    } else if (verdict === 'failure') {
      this.failures += 1;
      if (this.failures >= this.policy.failureThreshold) this.open('Integration circuit opened');
    }
  }

  /** open → half_open once openMs has passed (checked lazily on use). */
  private refresh(): void {
    if (this.state === 'open' && this.clock() - this.openedAt >= this.policy.openMs) {
      this.state = 'half_open';
      this.probeInFlight = false;
      this.generation += 1;
      this.logger.log({ integration: this.integration }, 'Integration circuit half-open: next call probes');
    }
  }

  private open(text: string): void {
    this.state = 'open';
    this.openedAt = this.clock();
    this.generation += 1;
    this.logger.warn(
      { integration: this.integration, consecutiveFailures: this.failures, openForMs: this.policy.openMs },
      text,
    );
  }

  private close(): void {
    this.state = 'closed';
    this.failures = 0;
    this.generation += 1;
    this.logger.log({ integration: this.integration }, 'Integration circuit closed: provider recovered');
  }
}

/**
 * The breakers of one process, one per integration key. Created lazily; settings come from env
 * (`INTEGRATION_BREAKER_*`) when the integrations module starts, with safe defaults before that.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private settings: BreakerSettings = DEFAULT_BREAKER_SETTINGS,
    private readonly clock: () => number = () => performance.now(),
    private readonly logger?: BreakerLogger,
  ) {}

  configure(settings: BreakerSettings): this {
    this.settings = settings;
    for (const [key, breaker] of this.breakers) breaker.setPolicy(this.policyFor(key));
    return this;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get(integration: string): CircuitBreaker {
    let breaker = this.breakers.get(integration);
    if (!breaker) {
      breaker = new CircuitBreaker(integration, this.policyFor(integration), this.clock, this.logger);
      this.breakers.set(integration, breaker);
    }
    return breaker;
  }

  /** Runs `call` through the integration's breaker (straight through when breakers are disabled). */
  execute<T>(integration: string, call: () => Promise<T>, verdict?: (error: unknown) => CallVerdict): Promise<T> {
    if (!this.settings.enabled) return call();
    return this.get(integration).execute(call, verdict);
  }

  snapshot(): BreakerSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  reset(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }

  policyFor(integration: string): BreakerPolicy {
    const override = this.settings.overrides[integration] ?? {};
    return {
      failureThreshold: override.failureThreshold ?? this.settings.failureThreshold,
      openMs: override.openMs ?? this.settings.openMs,
    };
  }
}

/**
 * `fcm=10/60,smtp=3/120` → { fcm: { failureThreshold: 10, openMs: 60000 }, … }. Entries that do
 * not parse are ignored (the env schema rejects them first).
 */
export function parseBreakerOverrides(value: string): Record<string, Partial<BreakerPolicy>> {
  const overrides: Record<string, Partial<BreakerPolicy>> = {};
  for (const entry of value.split(',')) {
    const match = /^\s*([a-z0-9-]+)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/i.exec(entry);
    if (!match) continue;
    const threshold = Number(match[2]);
    const seconds = Number(match[3]);
    if (threshold < 1 || seconds < 1) continue;
    overrides[match[1].toLowerCase()] = { failureThreshold: threshold, openMs: seconds * 1000 };
  }
  return overrides;
}

/** The process-wide registry (one per process: every integration call shares it). */
export const integrationBreakers = new CircuitBreakerRegistry();
