import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import type Stripe from 'stripe';
import { Notifier } from '@/common/contracts/notifier.contract';
import { TimeService } from '@/common/time/time.service';
import { QueueName } from '@/infra/queue/queue.constants';
import { BillingCustomer, Payment, PaymentEvent, PaymentStatus, Subscription } from './schemas/billing.schemas';

export interface StripeEventJob {
  eventId: string;
}

type Outcome = 'processed' | 'ignored';

/**
 * Webhook events: recorded once (unique event id, so Stripe's retries are acknowledged without
 * doing anything twice), handed to the `stripe-events` queue so a slow handler never makes the
 * webhook time out, then applied by the worker. Handlers are conditional (status transitions,
 * provider timestamps), so a replayed or out-of-order event cannot move state backwards.
 */
@Injectable()
export class StripeEventsService {
  private readonly logger = new Logger(StripeEventsService.name);

  constructor(
    @InjectModel(PaymentEvent.name) private readonly events: Model<PaymentEvent>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(BillingCustomer.name) private readonly customers: Model<BillingCustomer>,
    @InjectQueue(QueueName.STRIPE_EVENTS) private readonly queue: Queue<StripeEventJob>,
    private readonly notifier: Notifier,
    private readonly time: TimeService,
  ) {}

  /** Stores a verified event and queues it; false when it was already received. */
  async receive(event: Stripe.Event): Promise<boolean> {
    try {
      await this.events.create({
        eventId: event.id,
        type: event.type,
        livemode: event.livemode,
        created: event.created,
        data: event.data as unknown as Record<string, unknown>,
        status: 'received',
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
    // Deterministic id: a duplicate enqueue (crash between insert and add, then a Stripe retry) is ignored.
    await this.queue.add(event.type, { eventId: event.id }, { jobId: `stripe-${event.id}` });
    return true;
  }

  /** Worker side: applies one recorded event. Safe to run more than once. */
  async process(eventId: string): Promise<Outcome | 'missing' | 'done'> {
    const row = await this.events.findOne({ eventId }).lean().exec();
    if (!row) return 'missing';
    if (row.status === 'processed' || row.status === 'ignored') return 'done';
    const event = { id: row.eventId, type: row.type, created: row.created, data: row.data } as unknown as Stripe.Event;
    try {
      const outcome = await this.apply(event);
      await this.events.updateOne(
        { eventId },
        { $set: { status: outcome, processedAt: this.time.now(), error: null } },
      );
      return outcome;
    } catch (error) {
      await this.events.updateOne(
        { eventId },
        { $set: { status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' } },
      );
      throw error;
    }
  }

  private async apply(event: Stripe.Event): Promise<Outcome> {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
        return this.setPaymentStatus(event, session.id, paid ? 'paid' : 'pending', session.metadata?.userId);
      }
      case 'checkout.session.async_payment_failed':
        return this.setPaymentStatus(event, event.data.object.id, 'failed', event.data.object.metadata?.userId);
      case 'checkout.session.expired':
        return this.setPaymentStatus(event, event.data.object.id, 'expired', event.data.object.metadata?.userId);
      case 'payment_intent.succeeded':
        return this.setPaymentStatus(event, event.data.object.id, 'paid', event.data.object.metadata?.userId);
      case 'payment_intent.payment_failed':
        return this.setPaymentStatus(event, event.data.object.id, 'failed', event.data.object.metadata?.userId);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.upsertSubscription(event, event.data.object);
      default:
        return 'ignored';
    }
  }

  /**
   * Moves a payment forward only (pending → paid / failed / expired; never back to pending, never
   * paid → failed), and tells the person once when it is paid (the occurrence is the event id).
   */
  private async setPaymentStatus(
    event: Stripe.Event,
    externalId: string,
    status: PaymentStatus,
    userId?: string,
  ): Promise<Outcome> {
    const from: PaymentStatus[] = status === 'pending' ? [] : ['pending'];
    const updated = await this.payments
      .findOneAndUpdate(
        { externalId, status: { $in: from } },
        { $set: { status, lastEventId: event.id } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!updated) {
      if (!userId) return 'ignored';
      // Created outside this app (dashboard, CLI trigger): record it so history is complete.
      await this.payments.updateOne(
        { externalId },
        {
          $setOnInsert: {
            userId: new Types.ObjectId(userId),
            kind: externalId.startsWith('pi_') ? 'payment_intent' : 'checkout',
            priceId: 'unknown',
            status,
            lastEventId: event.id,
          },
        },
        { upsert: true },
      );
      return 'processed';
    }
    if (status === 'paid') {
      await this.notifier.notifyUsers({
        source: 'payment-received',
        occurrenceKey: event.id,
        userIds: [updated.userId.toHexString()],
        title: 'Payment received',
        body: 'Thank you! Your payment went through.',
        data: { screen: 'billing' },
        channels: ['push', 'inbox', 'email'],
      });
    }
    return 'processed';
  }

  /** Last write wins by provider time: an older event delivered late never overwrites newer state. */
  private async upsertSubscription(event: Stripe.Event, subscription: Stripe.Subscription): Promise<Outcome> {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const customer = await this.customers.findOne({ stripeCustomerId: customerId }).lean().exec();
    const userId =
      customer?.userId ?? (subscription.metadata?.userId ? new Types.ObjectId(subscription.metadata.userId) : null);
    if (!userId) {
      this.logger.warn({ eventId: event.id, customerId }, 'Subscription event for an unknown customer: ignored');
      return 'ignored';
    }
    const item = subscription.items?.data?.[0];
    const periodEnd = item?.current_period_end;
    const state = {
      userId,
      status: subscription.status,
      priceId: item?.price?.id ?? null,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      eventCreated: event.created,
    };
    const result = await this.subscriptions.updateOne(
      { stripeSubscriptionId: subscription.id, eventCreated: { $lte: event.created } },
      { $set: state },
    );
    if (result.matchedCount === 0) {
      await this.subscriptions.create({ stripeSubscriptionId: subscription.id, ...state }).catch((error: unknown) => {
        // Exists with newer state already: this event is stale.
        if ((error as { code?: number }).code !== 11000) throw error;
      });
    }
    return 'processed';
  }
}
