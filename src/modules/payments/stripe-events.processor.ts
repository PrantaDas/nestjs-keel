import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BaseProcessor } from '@/infra/queue/base.processor';
import { QueueName } from '@/infra/queue/queue.constants';
import { StripeEventJob, StripeEventsService } from './stripe-events.service';

/** Applies webhook events in the worker (registered only when Stripe is configured). */
@Processor(QueueName.STRIPE_EVENTS)
export class StripeEventsProcessor extends BaseProcessor<StripeEventJob, string> {
  constructor(private readonly events: StripeEventsService) {
    super();
  }

  protected handle(job: Job<StripeEventJob>): Promise<string> {
    return this.events.process(job.data.eventId);
  }
}
