import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { LockService } from './lock.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal core Redis: SET NX and the two token-checked scripts, with switchable failures. */
class FakeRedis {
  value?: string;
  down = false;
  stolen = false;

  async set(_key: string, token: string) {
    if (this.down) throw new Error('Command timed out');
    if (this.value) return null;
    this.value = token;
    return 'OK';
  }

  async eval(script: string, _keys: number, _key: string, token: string) {
    if (this.down) throw new Error('Command timed out');
    if (this.stolen || this.value !== token) return 0;
    if (script.includes('"del"')) this.value = undefined;
    return 1;
  }
}

describe('LockService', () => {
  let redis: FakeRedis;
  let locks: LockService;

  beforeEach(() => {
    redis = new FakeRedis();
    locks = new LockService(redis as unknown as Redis, { keyPrefix: 't:' } as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('fails closed by default when Redis is unreachable: the task never runs', async () => {
    redis.down = true;
    const task = jest.fn();
    await expect(locks.withLock('k', { ttlMs: 1000 }, task)).rejects.toThrow('Command timed out');
    expect(task).not.toHaveBeenCalled();
  });

  it('reports `unavailable` instead of throwing with onUnavailable: skip', async () => {
    redis.down = true;
    const task = jest.fn();
    await expect(locks.withLock('k', { ttlMs: 1000, onUnavailable: 'skip' }, task)).resolves.toMatchObject({
      acquired: false,
      reason: 'unavailable',
    });
    expect(task).not.toHaveBeenCalled();
  });

  it('reports `busy` when another holder has the lock', async () => {
    redis.value = 'someone-else';
    await expect(locks.withLock('k', { ttlMs: 1000 }, async () => 1)).resolves.toEqual({
      acquired: false,
      reason: 'busy',
    });
  });

  it('aborts the task signal when the renewal is refused (lock taken over)', async () => {
    let signal: AbortSignal | undefined;
    await locks.withLock('k', { ttlMs: 150 }, async (lock) => {
      signal = lock.signal;
      redis.stolen = true;
      await sleep(120);
    });
    expect(signal?.aborted).toBe(true);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k' }),
      'Lock lost while its task was still running',
    );
  });

  it('keeps the lock through short Redis blips, and gives it up after a whole TTL without renewal', async () => {
    let signal: AbortSignal | undefined;
    await locks.withLock('k', { ttlMs: 150 }, async (lock) => {
      signal = lock.signal;
      redis.down = true;
      await sleep(60);
      expect(lock.signal.aborted).toBe(false);
      await sleep(160);
    });
    expect(signal?.aborted).toBe(true);
  });

  it('releases the lock after the task, even when it fails', async () => {
    await expect(
      locks.withLock('k', { ttlMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(redis.value).toBeUndefined();
  });
});
