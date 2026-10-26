import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { DevicePlatform } from '@/common/contracts/device-registry.contract';
import { baseSchemaOptions } from '@/infra/database/base.schema';

/** One push token of one installation. A token belongs to one account at a time (the latest to register it). */
@Schema({ ...baseSchemaOptions, collection: 'device_tokens' })
export class DeviceToken {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  token: string;

  @Prop({ type: String, required: true, enum: ['ios', 'android', 'web'] })
  platform: DevicePlatform;

  @Prop({ type: String, default: null })
  appVersion: string | null;

  /** The session that registered it: signing that session out removes the token. */
  @Prop({ type: String, default: null })
  sessionId: string | null;

  @Prop({ required: true })
  lastSeenAt: Date;

  createdAt: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

DeviceTokenSchema.index({ token: 1 }, { unique: true });
// Tokens of a user (send), and of a session (sign-out).
DeviceTokenSchema.index({ userId: 1, lastSeenAt: -1 });
DeviceTokenSchema.index({ sessionId: 1 }, { sparse: true });
