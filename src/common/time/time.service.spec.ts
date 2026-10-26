import { RequestContext } from '@/common/context/request-context';
import { FixedClock, MovableClock } from './clock';
import { timePolicy } from './time-policy';
import { TimeService } from './time.service';

describe('TimeService', () => {
  // 12 Oct 2026, 21:00 UTC = 01:00 on the 13th in Dubai, 14:00 on the 12th in Los Angeles.
  const clock = new FixedClock('2026-10-12T21:00:00.000Z');
  const dubai = new TimeService(clock, timePolicy({ businessTimeZone: 'Asia/Dubai', weekStartsOn: 'monday' }));

  it('computes the business day in the business zone, never the server zone', () => {
    expect(dubai.businessDay()).toBe('2026-10-13');
    expect(dubai.businessDay(new Date('2026-10-12T19:59:59.999Z'))).toBe('2026-10-12');
    expect(dubai.businessDay(new Date('2026-10-12T20:00:00.000Z'))).toBe('2026-10-13');
  });

  it('gives the exact end of the business day for countdowns', () => {
    const window = dubai.businessDayWindow();
    expect(window.start.toISOString()).toBe('2026-10-12T20:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-13T20:00:00.000Z');
  });

  it('reports business week and month in the business zone', () => {
    expect(dubai.businessWeek().startDay).toBe('2026-10-12');
    expect(dubai.businessMonth(new Date('2026-10-31T20:30:00Z')).month).toBe('2026-11');
  });

  it('builds report ranges as half-open UTC intervals', () => {
    const range = dubai.dayRange('2026-10-01' as never, '2026-10-31' as never);
    expect(range.start.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-31T20:00:00.000Z');
  });

  it('turns wall-clock input into an instant and back', () => {
    const instant = dubai.toInstant({ date: '2026-10-14', time: '20:00', timeZone: 'Asia/Dubai' } as never);
    expect(instant.toISOString()).toBe('2026-10-14T16:00:00.000Z');
    expect(dubai.toLocal(instant, 'America/Los_Angeles' as never)).toEqual({
      date: '2026-10-14',
      time: '09:00',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('refuses a wall-clock time skipped by daylight saving', () => {
    expect(() => dubai.toInstant({ date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' } as never)).toThrow(
      /does not exist/,
    );
  });

  it('reads epoch seconds from the clock', () => {
    expect(dubai.epochSeconds()).toBe(Date.UTC(2026, 9, 12, 21) / 1000);
  });

  describe('userZone resolution (display only)', () => {
    const withHeaderZone = <T>(zone: string | undefined, fn: () => T): T =>
      RequestContext.run({ requestId: 'test', audit: {}, timeZone: zone as never }, fn);

    it('prefers the device header, then the stored profile value, then the business zone', () => {
      expect(withHeaderZone('Asia/Tokyo', () => dubai.userZone('Europe/London'))).toBe('Asia/Tokyo');
      expect(withHeaderZone(undefined, () => dubai.userZone('Europe/London'))).toBe('Europe/London');
      expect(withHeaderZone(undefined, () => dubai.userZone('UTC+05:30'))).toBe('Asia/Dubai');
      expect(dubai.userZone(null)).toBe('Asia/Dubai');
    });
  });
});

describe('MovableClock', () => {
  it('travels to a point in time and keeps ticking from there', () => {
    const base = new FixedClock('2026-10-26T00:00:00Z');
    const clock = new MovableClock(base);
    clock.travelTo(new Date('2026-09-01T08:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-09-01T08:00:00.000Z');
    base.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-09-01T08:00:01.500Z');
    clock.reset();
    expect(clock.now().toISOString()).toBe('2026-10-26T00:00:01.500Z');
  });
});
