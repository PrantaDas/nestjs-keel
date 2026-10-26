import { FixedClock, TimeService, UTC_POLICY } from '@/common/time';
import { HEARTBEAT_TTL_MS, HeartbeatService, heartbeatKey } from './heartbeat.service';

describe('HeartbeatService', () => {
  const time = new TimeService(new FixedClock('2026-10-25T06:00:00.000Z'), UTC_POLICY);

  function build(redis: Record<string, jest.Mock>) {
    return new HeartbeatService(redis as never, { keyPrefix: 'app:' } as never, 'worker', time);
  }

  it('writes a self-expiring heartbeat with the mode, instance and start time, and removes it on shutdown', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) };
    const service = build(redis);
    service.onApplicationBootstrap();
    await service.beat();

    const [key, value, unit, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(key).toBe(heartbeatKey('app:', 'worker', JSON.parse(value).instance));
    expect(JSON.parse(value)).toMatchObject({
      mode: 'worker',
      startedAt: '2026-10-25T06:00:00.000Z',
      lastSeenAt: '2026-10-25T06:00:00.000Z',
    });
    expect([unit, ttl]).toEqual(['PX', HEARTBEAT_TTL_MS]);

    await service.onApplicationShutdown();
    expect(redis.del).toHaveBeenCalledWith(key);
  });

  it('never throws while the core Redis is unreachable', async () => {
    const redis = {
      set: jest.fn().mockRejectedValue(new Error('down')),
      del: jest.fn().mockRejectedValue(new Error('down')),
    };
    const service = build(redis);
    service.onApplicationBootstrap();
    await expect(service.beat()).resolves.toBeUndefined();
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
