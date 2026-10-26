import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DeviceRegistry } from '@/common/contracts/device-registry.contract';
import { Notifier } from '@/common/contracts/notifier.contract';
import { notificationsConfig } from '@/config/configuration';
import { QueueName } from '@/infra/queue/queue.constants';
import { DeviceRegistryService } from './device-registry.service';
import { InboxService } from './inbox.service';
import {
  AdminNotificationsController,
  InternalNotificationsController,
  NotificationsController,
} from './notifications.controller';
import { NotificationsCron } from './notifications.cron';
import { NotificationsEventHandlers } from './notifications.handlers';
import { NotificationsProcessor } from './notifications.processor';
import { NotifierService } from './notifier.service';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';
import { InboxItem, InboxItemSchema } from './schemas/inbox-item.schema';
import { NotificationDelivery, NotificationDeliverySchema } from './schemas/notification-delivery.schema';
import { WebPushSubscriptionRecord, WebPushSubscriptionSchema } from './schemas/web-push-subscription.schema';
import { WebPushController, WebPushKeyController } from './web-push.controller';
import { WebPushSubscriptionsService } from './web-push-subscriptions.service';

const DAY_SECONDS = 86_400;

/** Ports for every process: `Notifier` (feature modules) and `DeviceRegistry` (identity). */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DeviceToken.name, schema: DeviceTokenSchema },
      { name: NotificationDelivery.name, schema: NotificationDeliverySchema },
      { name: WebPushSubscriptionRecord.name, schema: WebPushSubscriptionSchema },
    ]),
    MongooseModule.forFeatureAsync([
      {
        name: InboxItem.name,
        inject: [notificationsConfig.KEY],
        // The retention comes from config, so the TTL index is added here rather than on the schema.
        useFactory: (config: ConfigType<typeof notificationsConfig>) => {
          if (!InboxItemSchema.indexes().some(([, options]) => options?.expireAfterSeconds !== undefined)) {
            InboxItemSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.inboxRetentionDays * DAY_SECONDS });
          }
          return InboxItemSchema;
        },
      },
    ]),
    BullModule.registerQueue({ name: QueueName.NOTIFICATIONS }),
  ],
  providers: [
    DeviceRegistryService,
    NotifierService,
    InboxService,
    WebPushSubscriptionsService,
    { provide: DeviceRegistry, useExisting: DeviceRegistryService },
    { provide: Notifier, useExisting: NotifierService },
  ],
  exports: [DeviceRegistry, Notifier, DeviceRegistryService, InboxService, WebPushSubscriptionsService, MongooseModule],
})
export class NotificationsCoreModule {}

@Module({
  imports: [NotificationsCoreModule],
  controllers: [
    NotificationsController,
    WebPushKeyController,
    WebPushController,
    AdminNotificationsController,
    InternalNotificationsController,
  ],
})
export class NotificationsApiModule {}

@Module({
  imports: [NotificationsCoreModule],
  providers: [NotificationsProcessor, NotificationsEventHandlers],
})
export class NotificationsJobsModule {}

@Module({
  imports: [NotificationsCoreModule],
  providers: [NotificationsCron],
})
export class NotificationsCronModule {}
