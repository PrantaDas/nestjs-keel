import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { Server } from 'socket.io';
import { guardPublishes, guardSubscriptions } from './adapter-clients';
import { RealtimeEmitter } from './realtime-emitter.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Socket adapter Redis guards', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('handles rejected fire-and-forget subscriptions (no unhandled rejection) and logs them', async () => {
    const rejection = new Error('Connection is closed.');
    const client = {
      ssubscribe: jest.fn(() => Promise.reject(rejection)),
      sunsubscribe: jest.fn(() => Promise.reject(rejection)),
      subscribe: jest.fn(() => Promise.resolve(1)),
      unsubscribe: jest.fn(() => Promise.resolve(1)),
    };
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      guardSubscriptions(client as unknown as Redis, new Logger('spec'));
      // The adapter calls these without awaiting the result.
      void (client as unknown as Redis).ssubscribe('room-a');
      void (client as unknown as Redis).sunsubscribe('room-a');
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ssubscribe' }),
        'Socket adapter subscription failed',
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps local delivery when publishing to Redis fails, and logs the dropped broadcast', async () => {
    const server = new Server();
    const adapter = server.of('/').adapter as unknown as { doPublish: (m: unknown) => Promise<string> };
    adapter.doPublish = () => Promise.reject(new Error('Command timed out'));
    guardPublishes(server, 'spec');
    await expect(adapter.doPublish({})).resolves.toBe('');
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});

describe('RealtimeEmitter', () => {
  it('never throws into the request or job that emits, whatever the transport does', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const emitter = new RealtimeEmitter(
      { url: 'redis://127.0.0.1:1', keyPrefix: 't:' } as never,
      {
        redis: { connectTimeoutMs: 100, commandTimeoutMs: 100, maxRetriesPerRequest: 0, cacheCommandTimeoutMs: 50 },
      } as never,
    );
    // Not initialised: dropped with a log.
    expect(() => emitter.toUser('u1', 'event', {})).not.toThrow();
    // Initialised, but the server throws synchronously (e.g. an unserialisable payload).
    const broken = {
      to: () => {
        throw new Error('boom');
      },
      in: () => {
        throw new Error('boom');
      },
    };
    (emitter as unknown as { io: unknown }).io = broken;
    expect(() => emitter.toRoom('r', 'event', {})).not.toThrow();
    expect(() => emitter.disconnectSessions(['s1'])).not.toThrow();
    expect(() => emitter.socketsLeave('r', 't')).not.toThrow();
    jest.restoreAllMocks();
  });
});
