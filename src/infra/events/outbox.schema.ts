import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

export type OutboxStatus = 'pending' | 'published' | 'failed';

/**
 * Transactional outbox: one row per domain event, inserted in the same MongoDB transaction as the
 * state change, so an event exists if and only if its change committed. The relay (worker) moves it
 * to `published`; published rows are removed after a week by a TTL index.
 */
@Schema({ ...baseSchemaOptions, collection: 'outbox_events' })
export class OutboxEvent {
  @Prop({ required: true, unique: true })
  eventId: string;

  @Prop({ required: true })
  type: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, unknown>;

  @Prop({ required: true })
  occurredAt: Date;

  @Prop({ type: String, required: true, enum: ['pending', 'published', 'failed'], default: 'pending' })
  status: OutboxStatus;

  @Prop({ required: true, default: 0 })
  attempts: number;

  /** Not delivered before this instant (retry backoff). */
  @Prop({ required: true })
  availableAt: Date;

  /** Claimed by a relay until this instant; a crashed relay's claim simply expires. */
  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  @Prop({ type: String, default: null })
  claimToken: string | null;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ type: String, default: null })
  lastError: string | null;
}

export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

// Relay claim: due pending events in order.
OutboxEventSchema.index({ status: 1, availableAt: 1 });
OutboxEventSchema.index({ claimToken: 1 }, { sparse: true });
// Published events are kept a week for debugging, then expire.
OutboxEventSchema.index(
  { publishedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: 'published' } },
);
