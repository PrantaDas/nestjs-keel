import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UserDirectory } from '@/common/contracts/user-directory.contract';
import { RequestContext } from '@/common/context/request-context';
import { stripeConfig } from '@/config/configuration';
import { CacheService } from '@/infra/cache/cache.service';
import { GatewayPrice, PaymentGateway } from '@/integrations/stripe/payment-gateway.port';
import { CheckoutDto, CreateProductDto } from './dto/payments.dto';
import { PaymentsErrors, PaymentsException } from './payments.errors';
import { BillingCustomer, Payment, Subscription } from './schemas/billing.schemas';

const PRICES_CACHE_KEY = 'payments:prices';

/**
 * Purchases: the price list (cached), checkout sessions, payment intents and the customer portal.
 * Payment state is never trusted from the client: it changes only when a verified webhook says so
 * (`StripeEventsService`). Creates carry idempotency keys derived from the request, so a retried
 * request reuses the provider's first answer.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly cache: CacheService,
    private readonly directory: UserDirectory,
    @InjectModel(BillingCustomer.name) private readonly customers: Model<BillingCustomer>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @Inject(stripeConfig.KEY) private readonly config: ConfigType<typeof stripeConfig>,
  ) {}

  prices(): Promise<GatewayPrice[]> {
    return this.cache.wrap(PRICES_CACHE_KEY, () => this.gateway.listPrices(), { ttlSeconds: 300 });
  }

  async createProduct(dto: CreateProductDto): Promise<GatewayPrice> {
    const price = await this.gateway.createProductWithPrice(dto, this.idempotencyKey('product'));
    await this.cache.del(PRICES_CACHE_KEY);
    return price;
  }

  async checkout(userId: string, dto: CheckoutDto): Promise<{ url: string; sessionId: string }> {
    const price = await this.requirePrice(dto.priceId);
    if ((dto.mode === 'subscription') !== Boolean(price.recurring)) {
      throw new PaymentsException(PaymentsErrors.WRONG_PRICE_TYPE);
    }
    const customerId = await this.ensureCustomer(userId);
    const session = await this.gateway.createCheckoutSession(
      {
        customerId,
        priceId: price.id,
        mode: dto.mode,
        quantity: dto.quantity ?? 1,
        userId,
        successUrl: this.config.successUrl,
        cancelUrl: this.config.cancelUrl,
      },
      this.idempotencyKey(`checkout-${userId}`),
    );
    await this.payments.updateOne(
      { externalId: session.id },
      {
        $setOnInsert: {
          userId: new Types.ObjectId(userId),
          kind: 'checkout',
          priceId: price.id,
          amount: price.unitAmount * (dto.quantity ?? 1),
          currency: price.currency,
          status: 'pending',
        },
      },
      { upsert: true },
    );
    return { url: session.url, sessionId: session.id };
  }

  async paymentIntent(userId: string, priceId: string): Promise<{ paymentIntentId: string; clientSecret: string }> {
    const price = await this.requirePrice(priceId);
    if (price.recurring) throw new PaymentsException(PaymentsErrors.WRONG_PRICE_TYPE);
    const customerId = await this.ensureCustomer(userId);
    const intent = await this.gateway.createPaymentIntent(
      { customerId, amount: price.unitAmount, currency: price.currency, userId, priceId: price.id },
      this.idempotencyKey(`intent-${userId}`),
    );
    await this.payments.updateOne(
      { externalId: intent.id },
      {
        $setOnInsert: {
          userId: new Types.ObjectId(userId),
          kind: 'payment_intent',
          priceId: price.id,
          amount: price.unitAmount,
          currency: price.currency,
          status: 'pending',
        },
      },
      { upsert: true },
    );
    return { paymentIntentId: intent.id, clientSecret: intent.clientSecret };
  }

  async portal(userId: string): Promise<{ url: string }> {
    const customer = await this.customers
      .findOne({ userId: new Types.ObjectId(userId) })
      .lean()
      .exec();
    if (!customer) throw new PaymentsException(PaymentsErrors.NO_BILLING_ACCOUNT);
    return this.gateway.createPortalSession({
      customerId: customer.stripeCustomerId,
      returnUrl: this.config.portalReturnUrl,
    });
  }

  async overview(userId: string) {
    const owner = new Types.ObjectId(userId);
    const [payments, subscription] = await Promise.all([
      this.payments.find({ userId: owner }).sort({ createdAt: -1 }).limit(50).lean().exec(),
      this.subscriptions.findOne({ userId: owner }).sort({ updatedAt: -1 }).lean().exec(),
    ]);
    return {
      payments: payments.map((p) => ({
        _id: p._id.toHexString(),
        kind: p.kind,
        priceId: p.priceId,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        createdAt: p.createdAt,
      })),
      subscription: subscription
        ? {
            status: subscription.status,
            priceId: subscription.priceId,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }
        : null,
    };
  }

  private async requirePrice(priceId: string): Promise<GatewayPrice> {
    const price = await this.gateway.getPrice(priceId);
    if (!price) throw new PaymentsException(PaymentsErrors.PRICE_NOT_FOUND);
    return price;
  }

  /** One provider customer per user; two first purchases racing end on the unique index, then reuse. */
  private async ensureCustomer(userId: string): Promise<string> {
    const owner = new Types.ObjectId(userId);
    const existing = await this.customers.findOne({ userId: owner }).lean().exec();
    if (existing) return existing.stripeCustomerId;
    const profile = (await this.directory.reachableUsers([userId])).get(userId);
    // Same key for every attempt of this user: the provider returns the first customer again.
    const stripeCustomerId = await this.gateway.createCustomer(
      { userId, email: profile?.email ?? null, name: profile?.name ?? 'Customer' },
      `customer-${userId}`,
    );
    try {
      await this.customers.create({ userId: owner, stripeCustomerId });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    return stripeCustomerId;
  }

  /** Idempotency key for a provider create: the request id, so a retried request reuses the first answer. */
  private idempotencyKey(scope: string): string {
    return `${scope}-${RequestContext.requestId() ?? new Types.ObjectId().toHexString()}`;
  }
}
