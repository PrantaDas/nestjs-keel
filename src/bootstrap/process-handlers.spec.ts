import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { handleFatalError, resetFatalStateForTests, setFatalShutdown } from './process-handlers';
import type { GracefulShutdown } from './shutdown';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn(), flush: jest.fn() }));

describe('handleFatalError', () => {
  let exit: jest.Mock;
  let flush: jest.Mock;

  beforeEach(() => {
    resetFatalStateForTests();
    jest.clearAllMocks();
    exit = jest.fn();
    flush = jest.fn(() => Promise.resolve(true));
    jest.spyOn(Logger.prototype, 'fatal').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs, reports to Sentry, then runs the graceful shutdown with exit code 1', () => {
    const shutdown = { shutdown: jest.fn(() => Promise.resolve()) };
    setFatalShutdown(shutdown as unknown as GracefulShutdown);
    const error = new Error('handler blew up');

    handleFatalError(error, 'unhandledRejection', { exit, flush });

    expect(Logger.prototype.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, origin: 'unhandledRejection' }),
      'Fatal unhandledRejection: exiting',
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(error, expect.objectContaining({ level: 'fatal' }));
    expect(shutdown.shutdown).toHaveBeenCalledWith('unhandledRejection', 1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('before the app exists (boot): flushes Sentry and exits 1', async () => {
    handleFatalError(new Error('bad config'), 'bootFailure', { exit, flush });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flush).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports a second fatal error without starting another shutdown', () => {
    const shutdown = { shutdown: jest.fn(() => Promise.resolve()) };
    setFatalShutdown(shutdown as unknown as GracefulShutdown);
    handleFatalError(new Error('first'), 'uncaughtException', { exit, flush });
    handleFatalError(new Error('second'), 'unhandledRejection', { exit, flush });
    expect(shutdown.shutdown).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });
});
