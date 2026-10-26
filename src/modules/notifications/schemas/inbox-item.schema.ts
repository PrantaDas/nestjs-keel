import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

/**
 * In-app inbox: a push is not storage (it may never arrive, and disappears once dismissed), so every
 * notification sent with the `inbox` channel is also kept here for the app's notification list.
 * Removed after NOTIFICATIONS_INBOX_RETENTION_DAYS (TTL index added by the module).
 */
@Schema({ ...baseSchemaOptions, collection: 'notification_inbox' })
export class InboxItem {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  source: string;

  @Prop({ required: true })
  occurrenceKey: string;

  @Prop({ required: true, maxlength: 200 })
  title: string;

  @Prop({ type: String, default: null, maxlength: 2000 })
  body: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  data: Record<string, string> | null;

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  createdAt: Date;
}

export const InboxItemSchema = SchemaFactory.createForClass(InboxItem);

// One inbox row per notification occurrence and person (retries upsert the same row).
InboxItemSchema.index({ userId: 1, source: 1, occurrenceKey: 1 }, { unique: true });
// The app's list (newest first) and the unread badge.
InboxItemSchema.index({ userId: 1, createdAt: -1 });
InboxItemSchema.index({ userId: 1, readAt: 1 });
