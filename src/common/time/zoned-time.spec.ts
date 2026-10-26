import type { DayKey, LocalTime } from './time.types';
import {
  addDays,
  dayKeyOf,
  dayWindow,
  diffDays,
  instantToLocal,
  isDayKey,
  localToInstant,
  monthWindowAt,
  normalizeTimeZone,
  parseInstant,
  timeZone,
  weekWindowAt,
} from './zoned-time';

// Expected values were computed independently with Python's zoneinfo (IANA tzdata).
const at = (iso: string) => new Date(iso);
const day = (value: string) => value as DayKey;
const zone = (value: string) => timeZone(value);
const hours = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 3_600_000;

describe('zoned-time', () => {
  describe('dayKeyOf: the last and first millisecond of a day', () => {
    it.each([
      ['Asia/Kolkata (+05:30)', '2026-10-12T18:29:59.999Z', '2026-10-12'],
      ['Asia/Kolkata (+05:30)', '2026-10-12T18:30:00.000Z', '2026-10-13'],
      ['Asia/Kathmandu (+05:45)', '2026-10-12T18:14:59.999Z', '2026-10-12'],
      ['Asia/Kathmandu (+05:45)', '2026-10-12T18:15:00.000Z', '2026-10-13'],
      ['Asia/Dubai (+04)', '2026-10-12T19:59:59.999Z', '2026-10-12'],
      ['Asia/Dubai (+04)', '2026-10-12T20:00:00.000Z', '2026-10-13'],
      ['Pacific/Kiritimati (+14)', '2026-10-12T10:00:00.000Z', '2026-10-13'],
      ['Pacific/Pago_Pago (-11)', '2026-10-12T10:00:00.000Z', '2026-10-11'],
      ['UTC', '2026-10-12T23:59:59.999Z', '2026-10-12'],
    ])('%s at %s is %s', (label, instant, expected) => {
      expect(dayKeyOf(at(instant), zone(label.split(' ')[0]))).toBe(expected);
    });
  });

  describe('dayWindow: half-open [start, end), correct across daylight saving', () => {
    it.each([
      ['2026-10-13', 'Asia/Kolkata', '2026-10-12T18:30:00.000Z', '2026-10-13T18:30:00.000Z', 24],
      ['2026-10-13', 'Asia/Kathmandu', '2026-10-12T18:15:00.000Z', '2026-10-13T18:15:00.000Z', 24],
      ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
      ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
      ['2026-03-29', 'Europe/London', '2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z', 23],
      ['2026-10-25', 'Europe/London', '2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z', 25],
      ['2026-04-05', 'Australia/Sydney', '2026-04-04T13:00:00.000Z', '2026-04-05T14:00:00.000Z', 25],
      ['2026-10-04', 'Australia/Sydney', '2026-10-03T14:00:00.000Z', '2026-10-04T13:00:00.000Z', 23],
    ])('%s in %s', (d, z, start, end, length) => {
      const window = dayWindow(day(d), zone(z));
      expect(window.start.toISOString()).toBe(start);
      expect(window.end.toISOString()).toBe(end);
      expect(hours(window)).toBe(length);
    });

    it('next day starts exactly where the previous ends (no gap, no overlap)', () => {
      const today = dayWindow(day('2026-11-01'), zone('America/New_York'));
      const tomorrow = dayWindow(addDays(day('2026-11-01'), 1), zone('America/New_York'));
      expect(tomorrow.start.getTime()).toBe(today.end.getTime());
    });
  });

  describe('weeks and months', () => {
    it('Sunday-start week containing Wed 14 Oct 2026 (India)', () => {
      const week = weekWindowAt(at('2026-10-14T06:00:00Z'), zone('Asia/Kolkata'), 'sunday');
      expect(week.startDay).toBe('2026-10-11');
      expect(week.start.toISOString()).toBe('2026-10-10T18:30:00.000Z');
      expect(week.end.toISOString()).toBe('2026-10-17T18:30:00.000Z');
    });

    it('Monday-start week, and a Sunday belongs to the week that started the Monday before', () => {
      expect(weekWindowAt(at('2026-10-14T06:00:00Z'), zone('Asia/Kolkata'), 'monday').startDay).toBe('2026-10-12');
      expect(weekWindowAt(at('2026-10-18T06:00:00Z'), zone('Asia/Kolkata'), 'monday').startDay).toBe('2026-10-12');
      expect(weekWindowAt(at('2026-10-18T06:00:00Z'), zone('Asia/Kolkata'), 'sunday').startDay).toBe('2026-10-18');
    });

    it('India month boundary (1st of the month, 00:00 local)', () => {
      const month = monthWindowAt(at('2026-10-15T00:00:00Z'), zone('Asia/Kolkata'));
      expect(month).toEqual({
        month: '2026-10',
        start: at('2026-09-30T18:30:00.000Z'),
        end: at('2026-10-31T18:30:00.000Z'),
      });
    });

    it('an instant just after India midnight on the 1st already belongs to the new month', () => {
      expect(monthWindowAt(at('2026-10-31T18:30:00.000Z'), zone('Asia/Kolkata')).month).toBe('2026-11');
    });
  });

  describe('calendar arithmetic is zone-free', () => {
    it('adds and diffs days across month and year ends', () => {
      expect(addDays(day('2026-12-31'), 1)).toBe('2027-01-01');
      expect(addDays(day('2028-03-01'), -1)).toBe('2028-02-29');
      expect(diffDays(day('2026-10-12'), day('2026-10-13'))).toBe(1);
      expect(diffDays(day('2026-03-07'), day('2026-03-09'))).toBe(2);
    });
  });

  describe('wall-clock schedules', () => {
    const local = (d: string, t: string, z: string) => ({ date: day(d), time: t as LocalTime, timeZone: zone(z) });

    it('converts admin input in Dubai and India to the right instant', () => {
      expect(localToInstant(local('2026-10-12', '20:00', 'Asia/Dubai'))?.toISOString()).toBe(
        '2026-10-12T16:00:00.000Z',
      );
      expect(localToInstant(local('2026-10-12', '20:00', 'Asia/Kolkata'))?.toISOString()).toBe(
        '2026-10-12T14:30:00.000Z',
      );
    });

    it('rejects a time skipped by a daylight-saving jump', () => {
      expect(localToInstant(local('2026-03-08', '02:30', 'America/New_York'))).toBeNull();
    });

    it('resolves a repeated (ambiguous) hour to its first occurrence', () => {
      expect(localToInstant(local('2026-11-01', '01:30', 'America/New_York'))?.toISOString()).toBe(
        '2026-11-01T05:30:00.000Z',
      );
    });

    it('round-trips instant → local → instant', () => {
      const instant = at('2026-10-12T16:00:00.000Z');
      const back = instantToLocal(instant, zone('Asia/Dubai'));
      expect(back).toEqual({ date: '2026-10-12', time: '20:00', timeZone: 'Asia/Dubai' });
      expect(localToInstant(back)?.getTime()).toBe(instant.getTime());
    });
  });

  describe('input parsing', () => {
    it.each([
      ['Asia/Kolkata', 'Asia/Kolkata'],
      ['Asia/Calcutta', 'Asia/Calcutta'],
      ['  Asia/Dubai ', 'Asia/Dubai'],
      ['UTC', 'UTC'],
      ['+05:30', null],
      ['UTC+05:30', null],
      ['GMT-4', null],
      ['India', null],
      ['', null],
      [5.5, null],
    ])('normalizeTimeZone(%p) → %p', (input, expected) => {
      expect(normalizeTimeZone(input)).toBe(expected);
    });

    it('treats legacy aliases exactly like the modern name', () => {
      const instant = at('2026-10-12T18:30:00.000Z');
      expect(dayKeyOf(instant, zone('Asia/Calcutta'))).toBe(dayKeyOf(instant, zone('Asia/Kolkata')));
    });

    it('accepts only real calendar days', () => {
      expect(isDayKey('2026-10-12')).toBe(true);
      expect(isDayKey('2026-02-30')).toBe(false);
      expect(isDayKey('2026-2-3')).toBe(false);
      expect(isDayKey('12/10/2026')).toBe(false);
    });

    it.each([
      ['2026-10-12T20:00:00Z', '2026-10-12T20:00:00.000Z'],
      ['2026-10-12T20:00:00.123+04:00', '2026-10-12T16:00:00.123Z'],
      ['2026-10-12T20:00+05:30', '2026-10-12T14:30:00.000Z'],
      ['2026-10-12T20:00:00', null],
      ['2026-10-12 20:00', null],
      ['2026-10-12', null],
      ['2026-13-40T10:00:00Z', null],
    ])('parseInstant(%p) → %p', (input, expected) => {
      expect(parseInstant(input)?.toISOString() ?? null).toBe(expected);
    });

    it('fails fast on a mistyped policy zone', () => {
      expect(() => timeZone('Asia/Kolkatta')).toThrow(/not a valid IANA timezone/);
    });
  });
});
