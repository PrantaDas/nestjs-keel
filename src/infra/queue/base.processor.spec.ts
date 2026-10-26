import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { type Job, UnrecoverableError } from 'bullmq';
import { IntegrationFailedException, IntegrationNotConfiguredException } from '@/common/exceptions';
import { asUnrecoverable, BaseProcessor, isPermanentFailure, isRetryable } from './base.processor';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn((callback: (scope: { setTags: jest.Mock }) => void) => callback({ setTags: jest.fn() })),
  captureException: jest.fn(),
}));

class ProbeProcessor extends BaseProcessor {
  protected handle(): Promise<unknown> {
    return Promise.resolve(null);
  }
}

/** A job as BullMQ hands it to the `failed` event (after moveToFailed incremented attemptsMade). */
const failedJob = (attemptsMade: number, attempts: number, finishedOn?: number) =>
  ({ id: 'j1', name: 'probe', queueName: 'probe-queue', attemptsMade, opts: { attempts }, finishedOn }) as Job;

describe('BaseProcessor failure reporting', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => logged.mockRestore());

  it('reports UnrecoverableError as a permanent failure at once, attempts left or not', () => {
    const error = new UnrecoverableError('bad params');
    new ProbeProcessor().onFailed(failedJob(1, 3), error);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ finalAttempt: true }), 'Job failed permanently');
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('only logs a failure that will be retried', () => {
    new ProbeProcessor().onFailed(failedJob(1, 3), new Error('S3 timeout'));
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ finalAttempt: false }), 'Job failed, will retry');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports the last failed attempt', () => {
    const error = new Error('still down');
    new ProbeProcessor().onFailed(failedJob(3, 3), error);
    expect(logged).toHaveBeenCalledWith(expect.anything(), 'Job failed permanently');
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('ignores events without a job', () => {
    new ProbeProcessor().onFailed(undefined, new Error('x'));
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('isPermanentFailure', () => {
  it('is true for UnrecoverableError (also by name, e.g. from a sandboxed processor)', () => {
    expect(isPermanentFailure(failedJob(1, 5), new UnrecoverableError('x'))).toBe(true);
    expect(isPermanentFailure(failedJob(1, 5), Object.assign(new Error('x'), { name: 'UnrecoverableError' }))).toBe(
      true,
    );
  });

  it('is true once the job moved to failed (finishedOn) or ran out of attempts', () => {
    expect(isPermanentFailure(failedJob(1, 5, 1_700_000_000_000), new Error('x'))).toBe(true);
    expect(isPermanentFailure(failedJob(5, 5), new Error('x'))).toBe(true);
    expect(isPermanentFailure(failedJob(2, 5), new Error('x'))).toBe(false);
  });
});

describe('BaseProcessor.process: permanent failures skip the remaining attempts', () => {
  class Throwing extends BaseProcessor {
    constructor(private readonly error: Error) {
      super();
    }

    protected handle(): Promise<unknown> {
      return Promise.reject(this.error);
    }
  }

  const job = { id: 'j1', name: 'probe', queueName: 'probe-queue', attemptsMade: 0, opts: { attempts: 5 } } as Job;

  beforeAll(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it.each([
    [
      'retryable: false (permanent provider answer, unknown outcome)',
      Object.assign(new Error('400'), { retryable: false }),
    ],
    ['INTEGRATION_NOT_CONFIGURED', new IntegrationNotConfiguredException('Twilio SMS')],
  ])('%s → UnrecoverableError with the same message', async (_label, error) => {
    const thrown = await new Throwing(error).process(job).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(thrown).toMatchObject({ message: (error as Error).message, cause: error });
  });

  it.each([
    ['retryable: true', Object.assign(new Error('503'), { retryable: true })],
    ['an unclassified error', new Error('db blip')],
    ['a bare integration failure', new IntegrationFailedException('AWS S3')],
  ])('%s is rethrown as is (BullMQ retries it)', async (_label, error) => {
    await expect(new Throwing(error).process(job)).rejects.toBe(error);
  });

  it('isRetryable / asUnrecoverable', () => {
    expect(isRetryable(new UnrecoverableError('x'))).toBe(false);
    expect(isRetryable(Object.assign(new Error('x'), { name: 'UnrecoverableError' }))).toBe(false);
    expect(isRetryable(undefined)).toBe(true);
    expect(asUnrecoverable('plain')).toMatchObject({ message: 'plain', cause: 'plain' });
  });
});
