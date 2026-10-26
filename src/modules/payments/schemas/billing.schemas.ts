import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

/** Our user ↔ the provider's customer. Created on the first purchase. */
@Schema({ ...baseSchemaOptions, collection: 'billing_customers' })
export class BillingCustomer {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true })
  stripeCustomerId: string;
}
export const BillingCustomerSchema = SchemaFactory.createForClass(BillingCustomer);
BillingCustomerSchema.index({ userId: 1 }, { unique: true });
BillingCustomerSchema.index({ stripeCustomerId: 1 }, { unique: true });

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired';

/** One checkout session or payment intent started by a user, updated by webhooks. */
@Schema({ ...baseSchemaOptions, collection: 'payments' })
export class Payment {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['checkout', 'payment_intent'] })
  kind: 'checkout' | 'payment_intent';

  /** Checkout session id (`cs_…`) or payment intent id (`pi_…`). */
  @Prop({ type: String, required: true })
  externalId: string;

  @Prop({ type: String, required: true })
  priceId: string;

  @Prop({ type: Number, default: null })
  amount: number | null;

  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: String, required: true, enum: ['pending', 'paid', 'failed', 'expired'], default: 'pending' })
  status: PaymentStatus;

  /** The webhook event that last changed it (debugging, ordering). */
  @Prop({ type: String, default: null })
  lastEventId: string | null;

  createdAt: Date;
  updatedAt: Date;
}
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ externalId: 1 }, { unique: true });
PaymentSchema.index({ userId: 1, createdAt: -1 });

/** The user's subscription as the provider last reported it. */
@Schema({ ...baseSchemaOptions, collection: 'subscriptions' })
export class Subscription {
  @Prop({ type: Types.ObjectId, required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true })
  stripeSubscriptionId: string;

  @Prop({ type: String, required: true })
  status: string;

  @Prop({ type: String, default: null })
  priceId: string | null;

  @Prop({ type: Date, default: null })
  currentPeriodEnd: Date | null;

  @Prop({ type: Boolean, default: false })
  cancelAtPeriodEnd: boolean;

  /** Provider timestamp of the event that wrote this state: older events never overwrite newer ones. */
  @Prop({ type: Number, required: true })
  eventCreated: number;
}
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
SubscriptionSchema.index({ stripeSubscriptionId: 1 }, { unique: true });
SubscriptionSchema.index({ userId: 1, updatedAt: -1 });

export type PaymentEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

/**
 * Every webhook event received, once (unique event id): the record of what the provider told us,
 * the idempotency key of the webhook route, and the work item of the `stripe-events` queue.
 */
@Schema({ ...baseSchemaOptions, collection: 'payment_events' })
export class PaymentEvent {
  @Prop({ type: String, required: true })
  eventId: string;

  @Prop({ type: String, required: true })
  type: string;

  @Prop({ type: Boolean, required: true })
  livemode: boolean;

  /** Provider creation time (epoch seconds). */
  @Prop({ type: Number, required: true })
  created: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  data: Record<string, unknown>;

  @Prop({ type: String, required: true, enum: ['received', 'processed', 'ignored', 'failed'], default: 'received' })
  status: PaymentEventStatus;

  @Prop({ type: Date, default: null })
  processedAt: Date | null;

  @Prop({ type: String, default: null })
  error: string | null;

  createdAt: Date;
}
export const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);
PaymentEventSchema.index({ eventId: 1 }, { unique: true });
PaymentEventSchema.index({ status: 1, createdAt: 1 });
