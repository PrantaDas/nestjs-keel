import { mongoConnectOptions, reconnectDelayMs } from './mongo-connection.supervisor';

describe('mongoConnectOptions', () => {
  it('bounds every wait so queries fail fast while MongoDB is down', () => {
    const options = mongoConnectOptions({ uri: 'mongodb://x', autoIndex: false, maxPoolSize: 50 }, {
      mongo: { serverSelectionTimeoutMs: 5000, connectTimeoutMs: 10_000, waitQueueTimeoutMs: 4000 },
    } as never);
    expect(options).toEqual({
      autoIndex: false,
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000,
      bufferTimeoutMS: 5000,
      connectTimeoutMS: 10_000,
      waitQueueTimeoutMS: 4000,
    });
  });
});

describe('reconnectDelayMs', () => {
  it('backs off exponentially with jitter and caps at 30 s', () => {
    expect(reconnectDelayMs(1, () => 1)).toBe(1000);
    expect(reconnectDelayMs(1, () => 0)).toBe(500);
    expect(reconnectDelayMs(4, () => 1)).toBe(8000);
    expect(reconnectDelayMs(30, () => 1)).toBe(30_000);
  });
});
