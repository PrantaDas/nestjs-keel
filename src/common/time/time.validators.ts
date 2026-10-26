import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateBy, type ValidationArguments, type ValidationOptions } from 'class-validator';
import type { DayKey, LocalTime, TimeZone } from './time.types';
import { isDayKey, isLocalTime, localToInstant, normalizeTimeZone, parseInstant } from './zoned-time';

/**
 * Instant input: ISO-8601 with `Z` or an offset (`2026-10-12T20:00:00+04:00`). Strings without
 * an offset are rejected (they would be read in the server's zone). Transforms to `Date`.
 */
export function IsInstant(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => parseInstant(value) ?? value),
    ValidateBy(
      {
        name: 'isInstant',
        validator: {
          validate: (value: unknown) => value instanceof Date && !Number.isNaN(value.getTime()),
          defaultMessage: (args?: ValidationArguments) =>
            `${args?.property} must be a date and time with a time zone, for example 2026-10-12T14:30:00Z`,
        },
      },
      options,
    ),
  );
}

/** Calendar day `YYYY-MM-DD` (a real date: 2026-02-30 is rejected). */
export function IsDayKey(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDayKey',
      validator: {
        validate: (value: unknown) => isDayKey(value),
        defaultMessage: (args?: ValidationArguments) =>
          `${args?.property} must be a date in the format YYYY-MM-DD, for example 2026-10-12`,
      },
    },
    options,
  );
}

/** IANA timezone name; normalised to its canonical form. Offsets like "+05:30" are rejected. */
export function IsTimeZone(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => normalizeTimeZone(value) ?? value),
    ValidateBy(
      {
        name: 'isTimeZone',
        validator: {
          validate: (value: unknown) => normalizeTimeZone(value) !== null,
          defaultMessage: (args?: ValidationArguments) =>
            `${args?.property} must be a time zone such as Europe/London or America/New_York`,
        },
      },
      options,
    ),
  );
}

/** `HH:mm` that exists on the sibling `date` in the sibling `timeZone` (DST gaps rejected). */
function IsExistingLocalTime(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isExistingLocalTime',
      validator: {
        validate: (value: unknown, args?: ValidationArguments) => {
          if (!isLocalTime(value)) return false;
          const { date, timeZone } = (args?.object ?? {}) as { date?: unknown; timeZone?: unknown };
          const zone = normalizeTimeZone(timeZone);
          // Sibling fields report their own errors; only check existence when they are valid.
          if (!isDayKey(date) || !zone) return true;
          return localToInstant({ date, time: value, timeZone: zone }) !== null;
        },
        defaultMessage: (args?: ValidationArguments) =>
          isLocalTime(args?.value)
            ? `${args?.property} doesn't exist on that day in that time zone because the clocks change. Choose another time`
            : `${args?.property} must be a 24-hour time in the format HH:mm, for example 20:00`,
      },
    },
    options,
  );
}

/**
 * Wall-clock input as a person enters it, e.g. an admin scheduling "20:00 on 12 Oct, Dubai time".
 * Convert with `TimeService.toInstant()`, store the instant plus `timeZone` (for editing/display).
 */
export class LocalDateTimeDto {
  @ApiProperty({ example: '2026-10-12', description: 'Calendar date YYYY-MM-DD' })
  @IsDayKey()
  date: DayKey;

  @ApiProperty({ example: '20:00', description: '24-hour wall-clock time HH:mm' })
  @IsExistingLocalTime()
  time: LocalTime;

  @ApiProperty({ example: 'Asia/Dubai', description: 'IANA timezone the time is expressed in' })
  @IsTimeZone()
  timeZone: TimeZone;
}
