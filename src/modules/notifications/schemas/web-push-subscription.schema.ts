import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

/**
 * One browser's Web Push subscription (`PushSubscription.toJSON()`). Like a device token, it belongs
 * to one account at a time: the latest to register it. Dropped when the push service answers 404 /
 * 410, when its session signs out, and when the account is deactivated or deleted.
 */
@Schema({ ...baseSchemaOptions, collection: 'web_push_subscriptions' })
export class WebPushSubscriptionRecord {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  /** The push service URL deliveries are POSTed to. */
  @Prop({ required: true, maxlength: 2048 })
  endpoint: string;

  @Prop({ required: true })
  p256dh: string;

  @Prop({ required: true })
  auth: string;

  /** When the browser said the subscription stops working (`expirationTime`); null = no end. */
  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  /** Shown in the list of my browsers, e.g. "Firefox on Windows". */
  @Prop({ type: String, default: null, maxlength: 100 })
  label: string | null;

  /** The session that registered it: signing that session out removes it. */
  @Prop({ type: String, default: null })
  sessionId: string | null;

  @Prop({ required: true })
  lastSeenAt: Date;

  createdAt: Date;
}

export const WebPushSubscriptionSchema = SchemaFactory.createForClass(WebPushSubscriptionRecord);

WebPushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
// Subscriptions of a user (send, list, cap), and of a session (sign-out).
WebPushSubscriptionSchema.index({ userId: 1, lastSeenAt: -1 });
WebPushSubscriptionSchema.index({ sessionId: 1 }, { sparse: true });
