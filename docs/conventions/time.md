# Time and time zones

Time bugs are the ones teams suffer longest: they pass every test written on one laptop, in one
zone, on an ordinary day, and fail for a user in another country, on a daylight-saving weekend, or
at midnight. The rules below make that class of bug hard to write, and the build fails when one is.
ADR: [0006](../adr/0006-time-rules.md).

## The rules

1. **The process always runs in UTC.** The first import of every entry point and CLI is
   `src/common/time/force-utc.ts`, which sets `TZ=UTC` and refuses to start if it did not stick.
   This keeps logs and libraries consistent, but **no code may depend on it**: rule 9 proves it.
2. **Nobody reads the wall clock in domain code.** `new Date()` and `Date.now()` are build errors
   outside `src/common/time` (ESLint `no-restricted-syntax` / `no-restricted-properties`, with a message
   pointing at `TimeService`). Inject `TimeService` (or `Clock`) and call `time.now()`.
   `performance.now()` stays allowed: it measures durations, not instants.
3. **Instants are UTC.** Store `Date`; send ISO-8601 with `Z`. Accept instants only with an explicit
   offset (`@IsInstant()` rejects `2026-10-12T20:00`, which would be read in the server's zone).
4. **Zones are IANA names** (`Europe/London`), never offsets (`+05:30`, `UTC+4`): an offset ignores
   daylight saving. `@IsTimeZone()` validates input; the env schema validates `BUSINESS_TIMEZONE`.
5. **The day a record belongs to is computed once, at write time, in the business zone, and stored**
   next to the instant (`createdDay: DayKey`, `YYYY-MM-DD`). Reports, uniqueness and "one per day"
   rules read the stored value. Never recompute a day from a timestamp at read time, and never from
   the viewer's zone. `TimeService.businessDay()` is the only way to get one.
6. **Wall-clock input is a `LocalDateTimeDto`** `{ date, time, timeZone }` ("14 Oct, 20:00 in
   Asia/Dubai"). Convert it with `TimeService.toInstant()` and store the instant **and** the zone, so
   it can be shown or rescheduled in the zone it was set in. Offset-style zones, unknown IANA names
   and times that do not exist because of daylight saving (02:30 on a spring-forward night) are
   rejected with the exact field named (`reminder.time`).
7. **Ranges are half-open** `[start, end)`. `TimeService.dayRange()` and `businessDayWindow()` return
   them; never build `23:59:59.999` end markers (days are 23 or 25 hours long twice a year).
8. **Scheduled jobs declare their zone.** `@LockedCron(expr, { name, timeZone })` refuses to register
   without one: `'business'` (the configured zone, "02:00 business time"), `'UTC'` (intervals), or an
   IANA name.
9. **Tests run under several server zones.** `pnpm test:tz` runs the unit suite with `TZ` set to UTC,
   the business zone example (Asia/Dubai), a negative offset (America/Los_Angeles) and UTC+14
   (Pacific/Kiritimati); `pnpm test:tz:e2e` runs the e2e suite in two of them. The e2e environment's
   business zone is Asia/Dubai on purpose, so a day computed in UTC by mistake shows up.

## The pieces

| What           | Where                            | Use                                                                                                                                                            |
| -------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Clock`        | `common/time/clock.ts`           | The source of "now"; `SystemClock` in production                                                                                                               |
| `FixedClock`   | same                             | Tests: frozen, `set()` / `advance()`                                                                                                                           |
| `MovableClock` | same                             | The seed: travels back and keeps ticking, to write history                                                                                                     |
| `TimeService`  | `common/time/time.service.ts`    | `now()`, `businessDay()`, `businessDayWindow()`, `businessWeek()`, `businessMonth()`, `dayRange()`, `toInstant()`, `toLocal()`, `userZone()`, `epochSeconds()` |
| `TimePolicy`   | `common/time/time-policy.ts`     | `BUSINESS_TIMEZONE`, `WEEK_STARTS_ON`: the only place zones are decided                                                                                        |
| Validators     | `common/time/time.validators.ts` | `@IsInstant`, `@IsDayKey`, `@IsTimeZone`, `LocalDateTimeDto`                                                                                                   |
| Zone math      | `common/time/zoned-time.ts`      | The only file that does it (Luxon), pure functions                                                                                                             |

## Where the clock reaches

- **Mongoose timestamps** read the injected clock (`connection.base.now = () => clock.now()` in
  `database.module.ts`), so a test that freezes time also freezes `createdAt` / `updatedAt`.
- **Tokens:** `iat` / `exp` and the verification instant come from the clock; clock skew between
  servers is `JWT_CLOCK_TOLERANCE_SECONDS`, in one place.
- **OTP expiry, outbox retries, idempotency, deprecation sunsets, webhook replay windows** are all
  measured on the clock.
- **Exceptions:** gRPC deadlines and the migration runner's history use the system clock on purpose
  (`systemClock`): they talk to the outside world, where test time means nothing.

## Display

`TimeService.userZone(stored)` picks the zone to show times in: the device's `X-Timezone` header,
then the profile's stored zone, then the business zone. It is for display only and never decides
which day a record belongs to. Every response carries `x-server-time`, so apps base countdowns on
the server's clock, not the device's.

## Examples in the code

- `NotesService.create` stores `createdDay` from `time.businessDay(now)`.
- `NotesService.reminderFrom` converts `{ date, time, timeZone }` to `remindAt` and keeps the zone.
- `NotesCron.purgeDeleted` runs `0 3 * * *` in `'business'`; `queueDueReminders` every minute in `'UTC'`.
- `20261026000000-notes-backfill-created-day.ts` computes day keys in the configured zone, in a migration.
- `test/e2e/notes.e2e-spec.ts` and `time.validators.spec.ts` cover daylight-saving gaps, past times
  and the day boundary.
