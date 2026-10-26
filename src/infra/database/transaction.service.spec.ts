import { Logger } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';
import { TransactionService, transactionBackoffMs } from './transaction.service';

/** A driver error carrying error labels, like MongoServerError. */
const mongoError = (labels: string[], code = 112) =>
  Object.assign(new Error(`mongo ${labels.join(',')}`), {
    name: 'MongoServerError',
    code,
    hasErrorLabel: (label: string) => labels.includes(label),
  });

class FakeSession {
  started = 0;
  aborted = 0;
  ended = false;
  private active = false;
  constructor(private readonly commits: (() => Promise<void>)[]) {}
  startTransaction() {
    this.started += 1;
    this.active = true;
  }
  inTransaction() {
    return this.active;
  }
  async abortTransaction() {
    this.aborted += 1;
    this.active = false;
  }
  async commitTransaction() {
    const next = this.commits.shift();
    if (next) await next();
    this.active = false;
  }
  async endSession() {
    this.ended = true;
  }
}

describe('TransactionService', () => {
  let sessions: FakeSession[];
  let commitPlan: (() => Promise<void>)[];
  let sleeps: number[];
  let service: TransactionService;

  const create = (maxAttempts = 5, windowMs = 10_000) => {
    const connection = {
      startSession: jest.fn(async () => {
        const session = new FakeSession(commitPlan);
        sessions.push(session);
        return session;
      }),
    } as unknown as Connection;
    service = new TransactionService(connection, {
      mongo: { transactionMaxAttempts: maxAttempts, transactionRetryWindowMs: windowMs },
    } as never);
    jest
      .spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockImplementation(async (ms) => {
        sleeps.push(ms);
      });
  };

  beforeEach(() => {
    sessions = [];
    commitPlan = [];
    sleeps = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    create();
  });

  afterEach(() => jest.restoreAllMocks());

  it('commits once and ends the session on success', async () => {
    await expect(service.run(async () => 'ok')).resolves.toBe('ok');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ started: 1, aborted: 0, ended: true });
    expect(sleeps).toEqual([]);
  });

  it('re-runs the whole callback in a new transaction after a TransientTransactionError', async () => {
    let calls = 0;
    const result = await service.run(async (session: ClientSession) => {
      calls += 1;
      if (calls < 3) throw mongoError(['TransientTransactionError']);
      return session;
    });
    expect(calls).toBe(3);
    expect(sessions).toHaveLength(3);
    expect(result).toBe(sessions[2]);
    expect(sessions.slice(0, 2).every((s) => s.aborted === 1 && s.ended)).toBe(true);
    expect(sleeps).toHaveLength(2);
  });

  it('retries a transient error raised by the commit with a fresh transaction', async () => {
    commitPlan.push(() => Promise.reject(mongoError(['TransientTransactionError'])));
    let calls = 0;
    await service.run(async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });

  it('retries only the commit when its outcome is unknown', async () => {
    commitPlan.push(
      () => Promise.reject(mongoError(['UnknownTransactionCommitResult'], 91)),
      () => Promise.reject(mongoError(['UnknownTransactionCommitResult'], 91)),
    );
    let calls = 0;
    await service.run(async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(2);
  });

  it('never retries a commit that hit MaxTimeMSExpired', async () => {
    const error = mongoError(['UnknownTransactionCommitResult'], 50);
    commitPlan.push(() => Promise.reject(error));
    await expect(service.run(async () => undefined)).rejects.toBe(error);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the configured attempts and throws the last error', async () => {
    create(3);
    const error = mongoError(['TransientTransactionError']);
    let calls = 0;
    await expect(
      service.run(async () => {
        calls += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('starts no retry once the retry window is spent', async () => {
    create(10, 0);
    let calls = 0;
    await expect(
      service.run(async () => {
        calls += 1;
        throw mongoError(['TransientTransactionError']);
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('never retries business errors: aborts and rethrows at once', async () => {
    const error = new Error('insufficient balance');
    await expect(
      service.run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ aborted: 1, ended: true });
  });
});

describe('transactionBackoffMs', () => {
  it('grows exponentially with jitter between 50 and 100 % of the step, capped at 500 ms', () => {
    expect(transactionBackoffMs(1, () => 0)).toBe(5);
    expect(transactionBackoffMs(1, () => 1)).toBe(10);
    expect(transactionBackoffMs(3, () => 0.5)).toBe(30);
    expect(transactionBackoffMs(20, () => 1)).toBe(500);
    expect(transactionBackoffMs(20, () => 0)).toBe(250);
  });
});
