import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { DomainEvent } from '@/common/events/domain-event';
import { UserDeactivated, UserDeleted } from '@/common/contracts/identity.events';
import { OnDomainEvent } from '@/infra/events/on-domain-event.decorator';
import { DeviceRegistryService } from './device-registry.service';
import { InboxService } from './inbox.service';
import { NotificationDelivery } from './schemas/notification-delivery.schema';

/**
 * Identity events, handled in the worker (outbox relay, at least once: every step is idempotent).
 * A deactivated account's devices leave every topic and are forgotten (the app registers again at
 * the next sign-in); a deleted account loses its inbox and delivery history too.
 */
@Injectable()
export class NotificationsEventHandlers {
  constructor(
    private readonly devices: DeviceRegistryService,
    private readonly inbox: InboxService,
    @InjectModel(NotificationDelivery.name) private readonly deliveries: Model<NotificationDelivery>,
  ) {}

  @OnDomainEvent(UserDeactivated)
  async onDeactivated(event: DomainEvent<{ userId: string }>): Promise<void> {
    await this.devices.removeAllForUser(event.payload.userId);
  }

  @OnDomainEvent(UserDeleted)
  async onDeleted(event: DomainEvent<{ userId: string }>): Promise<void> {
    await this.devices.removeAllForUser(event.payload.userId);
    await this.inbox.removeForUser(event.payload.userId);
    await this.deliveries.deleteMany({ userId: new Types.ObjectId(event.payload.userId) }).exec();
  }
}
