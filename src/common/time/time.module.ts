import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { timeConfig } from '@/config/configuration';
import { Clock, SystemClock } from './clock';
import { TIME_POLICY_TOKEN, timePolicy } from './time-policy';
import { TimeService } from './time.service';

/** Tests replace `Clock` with a FixedClock (`overrideProvider(Clock)`) and may override the policy. */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
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
