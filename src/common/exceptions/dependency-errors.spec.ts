import { unavailableDependency } from './dependency-errors';
import { mapException } from './exception-mapper';

const named = (name: string, message = 'x', extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name }, extra);

const withLabels = (name: string, labels: string[], code?: number) =>
  Object.assign(named(name), { code, hasErrorLabel: (label: string) => labels.includes(label) });

describe('unavailableDependency', () => {
  it.each([
    ['server selection', named('MongoServerSelectionError')],
    ['Mongoose server selection', named('MongooseServerSelectionError')],
    ['network', named('MongoNetworkError')],
    ['network timeout', named('MongoNetworkTimeoutError')],
    ['pool wait queue', named('MongoWaitQueueTimeoutError')],
    ['closed topology', named('MongoTopologyClosedError')],
    ['buffering timeout', named('MongooseError', 'Operation `users.findOne()` buffering timed out after 5000ms')],
    ['transient transaction', withLabels('MongoServerError', ['TransientTransactionError'], 112)],
    ['unknown commit result', withLabels('MongoServerError', ['UnknownTransactionCommitResult'])],
    ['not writable primary (election)', withLabels('MongoServerError', [], 10107)],
    ['wrapped in a cause', Object.assign(new Error('outer'), { cause: named('MongoNetworkError') })],
  ])('recognises a MongoDB outage: %s', (_label, error) => {
    expect(unavailableDependency(error)).toBe('mongodb');
  });

  it.each([
    ['retries exhausted', named('MaxRetriesPerRequestError')],
    ['command timeout', new Error('Command timed out')],
    ['offline queue disabled', new Error("Stream isn't writeable and enableOfflineQueue options is false")],
    ['closed connection', new Error('Connection is closed.')],
    ['out of memory (noeviction)', named('ReplyError', "OOM command not allowed when used memory > 'maxmemory'.")],
    ['loading dataset', named('ReplyError', 'LOADING Redis is loading the dataset in memory')],
  ])('recognises a Redis outage: %s', (_label, error) => {
    expect(unavailableDependency(error)).toBe('redis');
  });

  it.each([
    ['duplicate key', withLabels('MongoServerError', [], 11000)],
    ['validation', named('ValidationError')],
    ['wrong Redis type', named('ReplyError', 'WRONGTYPE Operation against a key holding the wrong kind of value')],
    ['plain bug', new TypeError('cannot read properties of undefined')],
    ['non-error', 'boom'],
    ['null', null],
  ])('ignores %s', (_label, error) => {
    expect(unavailableDependency(error)).toBeUndefined();
  });
});

describe('mapException for dependency outages', () => {
  it('answers 503 DATABASE_UNAVAILABLE without leaking the driver message', () => {
    const mapped = mapException(named('MongoServerSelectionError', 'connect ECONNREFUSED 10.0.0.5:27017'), 'r1');
    expect(mapped).toMatchObject({ status: 503, dependency: 'mongodb', isServerError: true });
    expect(mapped.body).toEqual({
      success: false,
      errorCode: 9100,
      error: 'DATABASE_UNAVAILABLE',
      errorMessage: expect.any(String),
      requestId: 'r1',
    });
    expect(JSON.stringify(mapped.body)).not.toContain('10.0.0.5');
  });

  it('answers 503 REDIS_UNAVAILABLE for a Redis command timeout', () => {
    const mapped = mapException(new Error('Command timed out'));
    expect(mapped).toMatchObject({ status: 503, dependency: 'redis', body: { errorCode: 9101 } });
  });

  it('keeps unrelated unknown errors as INTERNAL_ERROR', () => {
    expect(mapException(new Error('boom'))).toMatchObject({ status: 500, body: { error: 'INTERNAL_ERROR' } });
    expect(mapException(new Error('boom')).dependency).toBeUndefined();
  });
});
