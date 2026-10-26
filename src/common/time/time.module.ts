import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { timeConfig } from '@/config/configuration';
import { Clock, SystemClock } from './clock';
import { TIME_POLICY_TOKEN, timePolicy } from './time-policy';
import { TimeService } from './time.service';

/**
 * The clock of processes started outside a test module (CLI tools). Only the seed sets it, to write
 * history through the real services with a moved clock. Tests use `overrideProvider(Clock)` instead.
 */
let processClock: Clock | undefined;
export function useProcessClock(clock: Clock): void {
  processClock = clock;
}

/** Tests replace `Clock` with a FixedClock (`overrideProvider(Clock)`) and may override the policy. */
@Global()
@Module({
  providers: [
    { provide: Clock, useFactory: (): Clock => processClock ?? new SystemClock() },
    {
      provide: TIME_POLICY_TOKEN,
      inject: [timeConfig.KEY],
      useFactory: (config: ConfigType<typeof timeConfig>) => timePolicy(config),
    },
    TimeService,
  ],
  exports: [Clock, TimeService],
})
export class TimeModule {}
