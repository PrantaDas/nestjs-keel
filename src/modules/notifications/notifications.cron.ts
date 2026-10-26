import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TimeService } from '@/common/time/time.service';
import { LockedCron } from '@/infra/cron/locked-cron.decorator';
import { STALE_SENDING_MS } from './notifications.constants';
import { NotificationDelivery } from './schemas/notification-delivery.schema';

/**
 * Closes deliveries a crashed worker left in `sending`. They are marked failed, never re-sent: the
 * worker may have pushed before it died, and a duplicate is worse than a gap. A sweep over stored
 * state, so a missed tick is caught up by the next.
 */
@Injectable()
export class NotificationsCron {
  private readonly logger = new Logger(NotificationsCron.name);

  constructor(
    @InjectModel(NotificationDelivery.name) private readonly deliveries: Model<NotificationDelivery>,
    private readonly time: TimeService,
  ) {}

  @LockedCron('*/5 * * * *', { name: 'notifications-stale-sweep', timeZone: 'UTC' })
  async closeStale(): Promise<void> {
    const cutoff = this.time.after(-STALE_SENDING_MS);
    const { modifiedCount } = await this.deliveries.updateMany(
      { status: 'sending', claimedAt: { $lt: cutoff } },
      { $set: { status: 'failed', error: 'worker stopped while sending' } },
    );
    if (modifiedCount) this.logger.warn({ closed: modifiedCount }, 'Stuck deliveries closed as failed');
  }
}
