import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DeviceRegistration, DeviceRegistry } from '@/common/contracts/device-registry.contract';
import { BaseException, SystemErrors } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import { PushSender } from '@/integrations/push/push.port';
import { TOPIC_ALL } from './notifications.constants';
import { DeviceToken } from './schemas/device-token.schema';

/**
 * Push tokens per account (`DeviceRegistry` port, used by identity at sign-in and sign-out). A token
 * that FCM reports dead is deleted by the sender; tokens of deactivated accounts leave every topic.
 */
@Injectable()
export class DeviceRegistryService extends DeviceRegistry {
  private readonly logger = new Logger(DeviceRegistryService.name);

  constructor(
    @InjectModel(DeviceToken.name) private readonly tokens: Model<DeviceToken>,
    private readonly push: PushSender,
    private readonly time: TimeService,
  ) {
    super();
  }

  /** Upsert by token: a token moves to the account that registers it last (shared or resold phone). */
  async register(userId: string, device: DeviceRegistration): Promise<void> {
    const existing = await this.tokens.findOne({ token: device.token }).lean().exec();
    await this.tokens
      .updateOne(
        { token: device.token },
        {
          $set: {
            userId: new Types.ObjectId(userId),
            platform: device.platform,
            appVersion: device.appVersion ?? null,
            sessionId: device.sessionId ?? null,
            lastSeenAt: this.time.now(),
          },
        },
        { upsert: true },
      )
      .exec();
    if (!existing) {
      // Topic membership is best effort: a push provider outage must not fail a sign-in.
      await this.push
        .subscribeToTopic([device.token], TOPIC_ALL)
        .catch((err: unknown) => this.logger.warn({ err, userId }, 'Token not subscribed to the default topic'));
    }
  }

  async removeForSessions(userId: string, sessionIds: readonly string[]): Promise<void> {
    if (!sessionIds.length) return;
    await this.removeWhere({ userId: new Types.ObjectId(userId), sessionId: { $in: [...sessionIds] } });
  }

  /**
   * Every token of the account leaves every topic and is deleted (deactivation, deletion). Called
   * from the `user.deactivated` handler in the worker: a provider failure throws so the event is
   * retried, because a token deleted while still subscribed would keep receiving broadcasts.
   */
  async removeAllForUser(userId: string): Promise<void> {
    await this.removeWhere({ userId: new Types.ObjectId(userId) }, { strict: true });
  }

  /** Tokens of these users, for a send (newest first per user). */
  async tokensFor(userIds: readonly Types.ObjectId[]): Promise<Array<{ userId: Types.ObjectId; token: string }>> {
    return this.tokens
      .find({ userId: { $in: userIds } }, { userId: 1, token: 1 })
      .sort({ userId: 1, lastSeenAt: -1 })
      .lean<Array<{ userId: Types.ObjectId; token: string }>>()
      .exec();
  }

  /** Dead tokens reported by FCM: deleted so they do not accumulate. */
  async prune(tokens: readonly string[]): Promise<number> {
    if (!tokens.length) return 0;
    const result = await this.tokens.deleteMany({ token: { $in: [...tokens] } }).exec();
    if (result.deletedCount) this.logger.log({ pruned: result.deletedCount }, 'Dead push tokens removed');
    return result.deletedCount;
  }

  /**
   * Leaves topics first, then deletes, so a removed device stops receiving broadcasts too. Without
   * `strict` (sign-out inside a request) a provider failure is logged and the tokens go anyway.
   * Push not configured means no device was ever subscribed: nothing to undo.
   */
  private async removeWhere(filter: Record<string, unknown>, { strict = false } = {}): Promise<void> {
    const rows = await this.tokens.find(filter, { token: 1 }).lean<Array<{ token: string }>>().exec();
    if (!rows.length) return;
    const tokens = rows.map((row) => row.token);
    try {
      await this.push.unsubscribeFromTopic(tokens, TOPIC_ALL);
    } catch (err) {
      const notConfigured =
        err instanceof BaseException && err.errorCode === SystemErrors.INTEGRATION_NOT_CONFIGURED.code;
      if (strict && !notConfigured) throw err;
      this.logger.warn({ err, count: tokens.length }, 'Tokens not unsubscribed from topics');
    }
    await this.tokens.deleteMany({ token: { $in: tokens } }).exec();
  }
}
