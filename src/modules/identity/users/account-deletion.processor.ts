import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BaseProcessor } from '@/infra/queue/base.processor';
import { QueueName } from '@/infra/queue/queue.constants';
import { UsersService } from './users.service';

export interface AccountDeletionJob {
  userId: string;
}

/** Anonymises one account whose grace period is over. Re-checks the request: safe to run twice. */
@Processor(QueueName.ACCOUNT_DELETION)
export class AccountDeletionProcessor extends BaseProcessor<AccountDeletionJob, boolean> {
  constructor(private readonly users: UsersService) {
    super();
  }

  protected handle(job: Job<AccountDeletionJob>): Promise<boolean> {
    return this.users.anonymize(job.data.userId);
  }
}
