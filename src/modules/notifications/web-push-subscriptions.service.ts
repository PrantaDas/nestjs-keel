import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { TimeService } from '@/common/time/time.service';
import type { LeanDoc } from '@/infra/database/base.repository';
import type { WebPushSubscription } from '@/integrations/push/web-push.port';
import { WebPushSender } from '@/integrations/push/web-push.port';
import { MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER } from './notifications.constants';
import { NotificationsErrors, NotificationsException } from './notifications.errors';
import { WebPushSubscriptionRecord } from './schemas/web-push-subscription.schema';

export interface BrowserSubscription extends WebPushSubscription {
  /** Unix milliseconds, as `PushSubscription.expirationTime`. */
  expirationTime?: number | null;
  label?: string;
  sessionId?: string;
}

export interface WebPushSubscriptionView {
  _id: string;
  label: string | null;
  /** Push service host only: the full URL is a capability and is never sent back. */
  service: string;
  expiresAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
}

const toView = (row: LeanDoc<WebPushSubscriptionRecord>): WebPushSubscriptionView => ({
  _id: row._id.toHexString(),
  label: row.label,
  service: new URL(row.endpoint).hostname,
  expiresAt: row.expiresAt,
  lastSeenAt: row.lastSeenAt,
  createdAt: row.createdAt,
});

/**
 * The browsers of an account that receive Web Push. Registration is an upsert by subscription URL:
 * the same browser subscribing again refreshes its keys, and a browser profile shared between
 * accounts moves to the account that registered it last. Delivery lives in the processor.
 */
@Injectable()
export class WebPushSubscriptionsService {
  private readonly logger = new Logger(WebPushSubscriptionsService.name);

  constructor(
    @InjectModel(WebPushSubscriptionRecord.name) private readonly subscriptions: Model<WebPushSubscriptionRecord>,
    private readonly webPush: WebPushSender,
    private readonly time: TimeService,
  ) {}

  /** The VAPID public key for `pushManager.subscribe`; INTEGRATION_NOT_CONFIGURED when browser push is off. */
  publicKey(): { publicKey: string } {
    return { publicKey: this.webPush.publicKey() };
  }

  async subscribe(userId: string, subscription: BrowserSubscription): Promise<WebPushSubscriptionView> {
    // Refuses to store what could never be delivered (and fails fast when browser push is off).
    this.webPush.publicKey();
    if (!this.webPush.acceptsEndpoint(subscription.endpoint)) {
      throw new NotificationsException(NotificationsErrors.WEB_PUSH_SERVICE_NOT_SUPPORTED);
    }
    const owner = new Types.ObjectId(userId);
    const row = await this.subscriptions
      .findOneAndUpdate(
        { endpoint: subscription.endpoint },
        {
          $set: {
            userId: owner,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            expiresAt: subscription.expirationTime ? new Date(subscription.expirationTime) : null,
            label: subscription.label ?? null,
            sessionId: subscription.sessionId ?? null,
            lastSeenAt: this.time.now(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<LeanDoc<WebPushSubscriptionRecord>>()
      .exec();
    await this.trim(owner);
    return toView(row);
  }

  async list(userId: string): Promise<WebPushSubscriptionView[]> {
    const rows = await this.subscriptions
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ lastSeenAt: -1 })
      .lean<LeanDoc<WebPushSubscriptionRecord>[]>()
      .exec();
    return rows.map(toView);
  }

  /** One of my browsers, by id (404 for anyone else's). */
  async remove(userId: string, id: string): Promise<void> {
    const result = isValidObjectId(id)
      ? await this.subscriptions.deleteOne({ _id: id, userId: new Types.ObjectId(userId) }).exec()
      : { deletedCount: 0 };
    if (!result.deletedCount) throw new NotificationsException(NotificationsErrors.WEB_PUSH_SUBSCRIPTION_NOT_FOUND);
  }

  /** The browser unsubscribing itself: it knows its URL, not our id. Already gone is fine. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.subscriptions.deleteOne({ endpoint, userId: new Types.ObjectId(userId) }).exec();
  }

  /** Subscriptions of these users, for a send (newest first per user). */
  async forUsers(userIds: readonly Types.ObjectId[]): Promise<LeanDoc<WebPushSubscriptionRecord>[]> {
    return this.subscriptions
      .find({ userId: { $in: userIds } })
      .sort({ userId: 1, lastSeenAt: -1 })
      .lean<LeanDoc<WebPushSubscriptionRecord>[]>()
      .exec();
  }

  /** Subscriptions the push service reported gone: deleted so they do not accumulate. */
  async prune(endpoints: readonly string[]): Promise<number> {
    if (!endpoints.length) return 0;
    const result = await this.subscriptions.deleteMany({ endpoint: { $in: [...endpoints] } }).exec();
    if (result.deletedCount) this.logger.log({ pruned: result.deletedCount }, 'Expired browser subscriptions removed');
    return result.deletedCount;
  }

  async removeForSessions(userId: string, sessionIds: readonly string[]): Promise<void> {
    if (!sessionIds.length) return;
    await this.subscriptions
      .deleteMany({ userId: new Types.ObjectId(userId), sessionId: { $in: [...sessionIds] } })
      .exec();
  }

  async removeForUser(userId: string): Promise<void> {
    await this.subscriptions.deleteMany({ userId: new Types.ObjectId(userId) }).exec();
  }

  /** Keeps the most recently seen browsers of an account (old profiles never unsubscribe). */
  private async trim(userId: Types.ObjectId): Promise<void> {
    const stale = await this.subscriptions
      .find({ userId }, { _id: 1 })
      .sort({ lastSeenAt: -1, _id: -1 })
      .skip(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    if (stale.length) await this.subscriptions.deleteMany({ _id: { $in: stale.map((row) => row._id) } }).exec();
  }
}
