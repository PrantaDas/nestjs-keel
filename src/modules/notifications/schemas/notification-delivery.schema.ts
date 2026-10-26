import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';

/**
 * One notification to one person, and the claim that makes sending safe to retry: the row is
 * created `queued` once per (source, occurrenceKey, user) (unique index: duplicates are ignored),
 * moved to `sending` by exactly one worker, and never sent again after that.
 */
@Schema({ ...baseSchemaOptions, collection: 'notification_deliveries' })
export class NotificationDelivery {
  @Prop({ required: true })
  source: string;

  @Prop({ required: true })
  occurrenceKey: string;

  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['queued', 'sending', 'sent', 'failed', 'skipped'], default: 'queued' })
  status: DeliveryStatus;

  @Prop({ type: Date, default: null })
  claimedAt: Date | null;

  /** The job attempt that claimed it; only that attempt may send. */
  @Prop({ type: String, default: null })
  claimToken: string | null;

  /** Pushes accepted by the provider: app devices (FCM) and browsers (Web Push) together. */
  @Prop({ required: true, default: 0 })
  pushSent: number;

  @Prop({ required: true, default: 0 })
  pushFailed: number;

  @Prop({ type: String, default: null })
  error: string | null;

  createdAt: Date;
}

export const NotificationDeliverySchema = SchemaFactory.createForClass(NotificationDelivery);

NotificationDeliverySchema.index({ source: 1, occurrenceKey: 1, userId: 1 }, { unique: true });
// Stuck-claim sweep, and the rows one job attempt claimed.
NotificationDeliverySchema.index({ status: 1, claimedAt: 1 });
NotificationDeliverySchema.index({ claimToken: 1 }, { sparse: true });
// Delivery history of a user, and removal on account deletion.
NotificationDeliverySchema.index({ userId: 1, createdAt: -1 });
