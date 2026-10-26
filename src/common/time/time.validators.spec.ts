import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { ValidationException } from '@/common/exceptions';
import { createValidationPipe } from '@/common/pipes/validation.pipe';
import { IsDayKey, IsInstant, IsTimeZone, LocalDateTimeDto } from './time.validators';

class ScheduleDto {
  @IsOptional()
  @IsInstant()
  startsAt?: Date;

  @IsOptional()
  @IsDayKey()
  day?: string;

  @IsOptional()
  @IsTimeZone()
  timeZone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalDateTimeDto)
  publishAt?: LocalDateTimeDto;
}

describe('time validators', () => {
  const pipe = createValidationPipe();
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: ScheduleDto }) as Promise<ScheduleDto>;
  const failures = async (body: Record<string, unknown>) => {
    const error = await validate(body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationException);
    return (error as ValidationException).details!;
  };

  it('turns valid inputs into typed values (instant → Date, zone → canonical name)', async () => {
    const dto = await validate({
      startsAt: '2026-10-12T20:00:00+04:00',
      day: '2026-10-12',
      timeZone: ' Asia/Dubai ',
      publishAt: { date: '2026-10-12', time: '20:00', timeZone: 'Asia/Dubai' },
    });
    expect(dto.startsAt).toEqual(new Date('2026-10-12T16:00:00.000Z'));
    expect(dto.timeZone).toBe('Asia/Dubai');
    expect(dto.publishAt).toBeInstanceOf(LocalDateTimeDto);
  });

  it('rejects ambiguous or offset-style inputs with a field-level reason', async () => {
    const details = await failures({ startsAt: '2026-10-12 20:00', day: '2026-02-30', timeZone: '+05:30' });
    expect(details.map((d) => d.field).sort()).toEqual(['day', 'startsAt', 'timeZone']);
    expect(details.find((d) => d.field === 'startsAt')?.message).toBe(
      'Start time must be a date and time with a time zone, for example 2026-10-12T14:30:00Z.',
    );
    expect(details.find((d) => d.field === 'timeZone')?.message).toBe(
      'Time zone must be a name such as Europe/London.',
    );
  });

  it('rejects a wall-clock time that does not exist because of a daylight-saving jump', async () => {
    const details = await failures({ publishAt: { date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' } });
    expect(details).toEqual([
      {
        field: 'publishAt.time',
        message: "Time doesn't exist on that day in that time zone because the clocks change. Choose another time.",
      },
    ]);
  });

  it('reports malformed nested parts individually', async () => {
    const details = await failures({ publishAt: { date: '12-10-2026', time: '8pm', timeZone: 'Dubai' } });
    expect(details.map((d) => d.field).sort()).toEqual(['publishAt.date', 'publishAt.time', 'publishAt.timeZone']);
  });
});
