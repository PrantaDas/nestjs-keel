import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { IntegrationCallException, IntegrationOutcomeUnknownException } from './failure';
import { SEND_CLAIM_TTL_MS, SEND_IN_FLIGHT_MS, SendOnceGuard } from './send-once';

/** The few Redis commands the guard uses, in memory, with a controllable clock. */
class FakeRedis {
  now = 0;
  readonly store = new Map<string, { value: string; expiresAt: number }>();

  set(key: string, value: string, _px: 'PX', ttl: number, mode?: 'NX'): Promise<'OK' | null> {
    this.expire();
    if (mode === 'NX' && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, { value, expiresAt: this.now + ttl });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    this.expire();
    return Promise.resolve(this.store.get(key)?.value ?? null);
  }

  pttl(key: string): Promise<number> {
    this.expire();
    const entry = this.store.get(key);
    return Promise.resolve(entry ? entry.expiresAt - this.now : -2);
  }

  eval(_script: string, _keys: number, key: string, expected: string): Promise<number> {
    if (this.store.get(key)?.value !== expected) return Promise.resolve(0);
    this.store.delete(key);
    return Promise.resolve(1);
  }

  private expire(): void {
    for (const [key, entry] of this.store) if (entry.expiresAt <= this.now) this.store.delete(key);
  }
}

const transient = new IntegrationCallException('Twilio SMS', {
  transient: true,
  ambiguous: false,
  reason: 'http_503',
});
const ambiguous = new IntegrationCallException('Twilio SMS', {
  transient: true,
  ambiguous: true,
  reason: 'timeout',
});

function setup() {
  const redis = new FakeRedis();
  const guard = new SendOnceGuard(redis as unknown as Redis, { keyPrefix: 't:' } as never);
  let sends = 0;
  const send = (error?: Error) => () => {
    sends += 1;
    return error ? Promise.reject(error) : Promise.resolve();
  };
  return { redis, guard, send, sends: () => sends };
}

describe('SendOnceGuard', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('sends once per key; repeats resolve "duplicate" without calling the provider', async () => {
    const { redis, guard, send, sends } = setup();
    await expect(guard.run('Twilio SMS', 'welcome-email:1', send())).resolves.toBe('sent');
    await expect(guard.run('Twilio SMS', 'welcome-email:1', send())).resolves.toBe('duplicate');
    await expect(guard.run('Twilio SMS', 'welcome-email:2', send())).resolves.toBe('sent');
    expect(sends()).toBe(2);
    expect(redis.store.get('t:send-once:welcome-email:1')?.value).toBe('sent');
  });

  it('concurrent duplicates: exactly one send, the other is told to retry later', async () => {
    const { guard, sends } = setup();
    let release!: () => void;
    let calls = 0;
    const slow = () => {
      calls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const first = guard.run('SMTP', 'report-email:9', slow);
    await new Promise((r) => setImmediate(r));
    const second = await guard.run('SMTP', 'report-email:9', slow).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(IntegrationCallException);
    expect(second).toMatchObject({ transient: true, reason: 'send_in_flight' });
    release();
    await expect(first).resolves.toBe('sent');
    expect(calls).toBe(1);
    expect(sends()).toBe(0);
  });

  it('a definite failure releases the claim so a retry can send', async () => {
    const { guard, send, sends } = setup();
    await expect(guard.run('Twilio SMS', 'k', send(transient))).rejects.toBe(transient);
    await expect(guard.run('Twilio SMS', 'k', send())).resolves.toBe('sent');
    expect(sends()).toBe(2);
    const notConfigured = new IntegrationNotConfiguredException('Twilio SMS');
    await expect(guard.run('Twilio SMS', 'other', send(notConfigured))).rejects.toBe(notConfigured);
    await expect(guard.run('Twilio SMS', 'other', send())).resolves.toBe('sent');
  });

  it('an ambiguous failure is never repeated: unknown outcome now and on every later run', async () => {
    const { guard, send, sends } = setup();
    const error = await guard.run('Twilio SMS', 'k', send(ambiguous)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationOutcomeUnknownException);
    expect(error).toMatchObject({ retryable: false, cause: ambiguous });
    await expect(guard.run('Twilio SMS', 'k', send())).rejects.toBeInstanceOf(IntegrationOutcomeUnknownException);
    expect(sends()).toBe(1);
  });

  it('a claim left pending by a crashed process turns into "unknown" once it is old', async () => {
    const { redis, guard, send, sends } = setup();
    await redis.set('t:send-once:k', 'pending', 'PX', SEND_CLAIM_TTL_MS, 'NX');
    redis.now += SEND_IN_FLIGHT_MS - 1;
    await expect(guard.run('SMTP', 'k', send())).rejects.toMatchObject({ reason: 'send_in_flight' });
    redis.now += 1;
    await expect(guard.run('SMTP', 'k', send())).rejects.toBeInstanceOf(IntegrationOutcomeUnknownException);
    expect(sends()).toBe(0);
  });

  it('without a key it just sends', async () => {
    const { guard, send, sends } = setup();
    await guard.run('SMTP', undefined, send());
    await guard.run('SMTP', undefined, send());
    expect(sends()).toBe(2);
  });
});
