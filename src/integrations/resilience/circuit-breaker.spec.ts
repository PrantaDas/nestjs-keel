import { IntegrationNotConfiguredException } from '@/common/exceptions';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  DEFAULT_BREAKER_SETTINGS,
  parseBreakerOverrides,
  type BreakerLogger,
} from './circuit-breaker';
import { IntegrationCallException, IntegrationUnavailableException } from './failure';

const transient = () =>
  new IntegrationCallException('Twilio SMS', { transient: true, ambiguous: false, reason: 'http_503' });
const permanent = () =>
  new IntegrationCallException('Twilio SMS', { transient: false, ambiguous: false, reason: 'http_400' });

function setup(failureThreshold = 3, openMs = 1_000) {
  let now = 0;
  const logs: { level: 'warn' | 'log'; text: string; message: object }[] = [];
  const logger: BreakerLogger = {
    warn: (message, text) => logs.push({ level: 'warn', text, message }),
    log: (message, text) => logs.push({ level: 'log', text, message }),
  };
  const breaker = new CircuitBreaker('twilio', { failureThreshold, openMs }, () => now, logger);
  const advance = (ms: number) => {
    now += ms;
  };
  const calls = { count: 0 };
  const ok = () =>
    breaker.execute(async () => {
      calls.count += 1;
      return 'ok';
    });
  const fail = (error: Error = transient()) =>
    breaker
      .execute(async () => {
        calls.count += 1;
        throw error;
      })
      .catch((e: unknown) => e);
  return { breaker, advance, logs, calls, ok, fail };
}

describe('CircuitBreaker', () => {
  it('opens after N consecutive transient failures and then fails fast without calling', async () => {
    const { breaker, logs, calls, ok, fail } = setup(3);
    await fail();
    await fail();
    expect(breaker.snapshot().state).toBe('closed');
    await fail();
    expect(breaker.snapshot()).toMatchObject({ state: 'open', consecutiveFailures: 3, retryInMs: 1_000 });
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', text: 'Integration circuit opened' }));

    const error = await ok().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationUnavailableException);
    expect(error).toMatchObject({ integration: 'twilio', retryAfterMs: 1_000, errorCode: 9150, httpStatus: 503 });
    expect(calls.count).toBe(3);
  });

  it('a success resets the consecutive count; permanent answers count as "provider up"', async () => {
    const { breaker, ok, fail } = setup(3);
    await fail();
    await fail();
    await ok();
    await fail();
    await fail(permanent());
    await fail();
    await fail();
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 2 });
  });

  it('ignores missing configuration (a local problem, not an outage)', async () => {
    const { breaker, fail } = setup(2);
    for (let i = 0; i < 5; i += 1) await fail(new IntegrationNotConfiguredException('Twilio SMS'));
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('half-opens after the open period: one probe, others fail fast; a good probe closes it', async () => {
    const { breaker, advance, logs, calls, fail } = setup(1, 1_000);
    await fail();
    advance(999);
    expect(await fail()).toBeInstanceOf(IntegrationUnavailableException);
    advance(1);
    expect(breaker.snapshot().state).toBe('half_open');

    let release!: () => void;
    const probe = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          calls.count += 1;
          release = () => resolve('probe ok');
        }),
    );
    const concurrent = await breaker.execute(async () => 'never').catch((e: unknown) => e);
    expect(concurrent).toBeInstanceOf(IntegrationUnavailableException);
    release();
    await expect(probe).resolves.toBe('probe ok');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(calls.count).toBe(2);
    expect(logs.map((l) => l.text)).toEqual([
      'Integration circuit opened',
      'Integration circuit half-open: next call probes',
      'Integration circuit closed: provider recovered',
    ]);
  });

  it('a failed probe re-opens the circuit for another full period', async () => {
    const { breaker, advance, logs, fail } = setup(1, 500);
    await fail();
    advance(500);
    await fail();
    expect(breaker.snapshot()).toMatchObject({ state: 'open', retryInMs: 500 });
    expect(logs.at(-1)?.text).toBe('Integration circuit re-opened: probe failed');
    advance(499);
    expect(breaker.snapshot().state).toBe('open');
    advance(1);
    expect(breaker.snapshot().state).toBe('half_open');
  });

  it('ignores late results of calls that started before the circuit opened', async () => {
    const { breaker, ok, fail } = setup(1, 1_000);
    let finishLate!: () => void;
    const late = breaker.execute(() => new Promise<string>((resolve) => (finishLate = () => resolve('late'))));
    await fail();
    expect(breaker.snapshot().state).toBe('open');
    finishLate();
    await late;
    expect(breaker.snapshot().state).toBe('open');
    expect(await ok().catch((e: unknown) => e)).toBeInstanceOf(IntegrationUnavailableException);
  });
});

describe('CircuitBreakerRegistry', () => {
  it('keeps one breaker per integration with per-integration overrides', async () => {
    let now = 0;
    const registry = new CircuitBreakerRegistry(
      { ...DEFAULT_BREAKER_SETTINGS, failureThreshold: 5, overrides: { twilio: { failureThreshold: 1, openMs: 10 } } },
      () => now,
      { warn: () => undefined, log: () => undefined },
    );
    expect(registry.get('twilio')).toBe(registry.get('twilio'));
    expect(registry.policyFor('twilio')).toEqual({ failureThreshold: 1, openMs: 10 });
    expect(registry.policyFor('fcm')).toEqual({ failureThreshold: 5, openMs: 30_000 });

    await registry.execute('twilio', () => Promise.reject(transient())).catch(() => undefined);
    await expect(registry.execute('twilio', async () => 1)).rejects.toBeInstanceOf(IntegrationUnavailableException);
    await expect(registry.execute('fcm', async () => 1)).resolves.toBe(1);
    expect(registry.snapshot().map((s) => [s.integration, s.state])).toEqual([
      ['twilio', 'open'],
      ['fcm', 'closed'],
    ]);
    now += 10;
    await expect(registry.execute('twilio', async () => 2)).resolves.toBe(2);
    registry.reset();
  });

  it('passes calls straight through when disabled', async () => {
    const registry = new CircuitBreakerRegistry({ ...DEFAULT_BREAKER_SETTINGS, enabled: false, failureThreshold: 1 });
    for (let i = 0; i < 3; i += 1) {
      await registry.execute('s3', () => Promise.reject(transient())).catch(() => undefined);
    }
    await expect(registry.execute('s3', async () => 'through')).resolves.toBe('through');
  });

  it('reconfigures existing breakers', () => {
    const registry = new CircuitBreakerRegistry();
    registry.get('smtp');
    registry.configure({ ...DEFAULT_BREAKER_SETTINGS, failureThreshold: 9, openMs: 1_000 });
    expect(registry.policyFor('smtp')).toEqual({ failureThreshold: 9, openMs: 1_000 });
  });
});

describe('parseBreakerOverrides', () => {
  it('reads `key=threshold/seconds` pairs and skips malformed ones', () => {
    expect(parseBreakerOverrides('fcm=10/60, TWILIO = 3 / 120,bad,s3=0/5,x=1')).toEqual({
      fcm: { failureThreshold: 10, openMs: 60_000 },
      twilio: { failureThreshold: 3, openMs: 120_000 },
    });
    expect(parseBreakerOverrides('')).toEqual({});
  });
});
