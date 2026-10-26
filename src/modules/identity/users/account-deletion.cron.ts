import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { LockedCron } from '@/infra/cron/locked-cron.decorator';
import { QueueName } from '@/infra/queue/queue.constants';
import type { AccountDeletionJob } from './account-deletion.processor';
import { UsersService } from './users.service';

const BATCH = 500;

/**
 * Hourly sweep over stored state (a missed tick is caught up by the next): every pending deletion
 * whose grace period is over gets a job, one per account (deterministic id: never queued twice
 * while the first is waiting). The work itself runs in the worker.
 */
@Injectable()
export class AccountDeletionCron {
  private readonly logger = new Logger(AccountDeletionCron.name);

  constructor(
    private readonly users: UsersService,
    @InjectQueue(QueueName.ACCOUNT_DELETION) private readonly queue: Queue<AccountDeletionJob>,
  ) {}

  @LockedCron('17 * * * *', { name: 'identity-deletion-sweep', timeZone: 'UTC' })
  async sweep(): Promise<void> {
    const due = await this.users.dueDeletions(BATCH);
    if (!due.length) return;
    await this.queue.addBulk(
      due.map((user) => ({
        name: 'anonymize',
        data: { userId: user._id.toHexString() },
        opts: { jobId: `account-deletion-${user._id.toHexString()}` },
      })),
    );
    this.logger.log({ queued: due.length }, 'Due account deletions queued');
  }
}
