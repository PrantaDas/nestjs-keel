# 0006. Time rules enforced by the build

Status: accepted · Date: 2026-10-26

## Context

Time zone and daylight-saving bugs pass tests written on one laptop and fail for users elsewhere.

## Decision

Process in UTC (checked at boot); no `new Date()` / `Date.now()` outside `common/time` (lint); an injectable `Clock`; instants in UTC with explicit offsets; IANA zones only; the business day computed once at write time and stored; half-open ranges; crons declare their zone; unit tests run under four server zones and e2e under two. Luxon is used only in `zoned-time.ts`. Details in conventions/time.md.

## Consequences

- Good: Tests freeze and move time; DST and midnight behaviour is tested.
- Cost: A little ceremony: inject `TimeService` instead of calling `Date`.
