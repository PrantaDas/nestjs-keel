import type { SendOnceStatus } from '@/integrations/resilience/send-once';
import { MailMessage, MailSender } from '@/integrations/mail/mail.port';
import {
  PushMessage,
  PushSender,
  PushSendOutcome,
  PushTokenMessage,
  TopicMembershipResult,
} from '@/integrations/push/push.port';
import { SmsMessage, SmsSender } from '@/integrations/sms/sms.port';
import { FileStorage, ObjectMetadata, PresignedUpload, UploadInput } from '@/integrations/storage/storage.port';
import { CheckoutInput, GatewayPrice, NewProduct, PaymentGateway } from '@/integrations/stripe/payment-gateway.port';

/*
 * In-memory stand-ins for every outbound provider, bound with `overrideProvider(Port)`: e2e tests
 * run the real app against real MongoDB and Redis, but never reach a provider. Each fake records
 * what it was asked to do so tests can assert on it.
 */

export class FakeMail extends MailSender {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<SendOnceStatus> {
    this.sent.push(message);
    return Promise.resolve('sent');
  }

  to(address: string): MailMessage[] {
    return this.sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(address));
  }
}

export class FakeSms extends SmsSender {
  readonly sent: SmsMessage[] = [];

  send(message: SmsMessage): Promise<SendOnceStatus> {
    this.sent.push(message);
    return Promise.resolve('sent');
  }
}

/** FCM stand-in: every token succeeds unless listed in `dead` (then reported unregistered). */
export class FakePush extends PushSender {
  readonly sent: PushTokenMessage[] = [];
  readonly topicSends: Array<{ topic: string; message: PushMessage }> = [];
  readonly subscribed = new Map<string, Set<string>>();
  readonly dead = new Set<string>();

  sendEach(messages: readonly PushTokenMessage[]): Promise<PushSendOutcome[]> {
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((m) =>
        this.dead.has(m.token)
          ? { ok: false, messageId: null, errorCode: 'messaging/registration-token-not-registered', invalidToken: true }
          : { ok: true, messageId: `fake/${m.token}`, errorCode: null, invalidToken: false },
      ),
    );
  }

  sendToTopic(topic: string, message: PushMessage): Promise<string> {
    this.topicSends.push({ topic, message });
    return Promise.resolve(`fake-topic/${topic}`);
  }

  subscribeToTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult> {
    const members = this.subscribed.get(topic) ?? new Set<string>();
    tokens.forEach((token) => members.add(token));
    this.subscribed.set(topic, members);
    return Promise.resolve({ successCount: tokens.length, failures: [] });
  }

  unsubscribeFromTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult> {
    tokens.forEach((token) => this.subscribed.get(topic)?.delete(token));
    return Promise.resolve({ successCount: tokens.length, failures: [] });
  }

  sentTo(token: string): PushTokenMessage[] {
    return this.sent.filter((m) => m.token === token);
  }
}

/** S3 stand-in: "uploading" is `putObject(key, …)` from the test; presigned URLs are fake. */
export class FakeStorage extends FileStorage {
  readonly objects = new Map<string, ObjectMetadata>();
  readonly deleted: string[] = [];

  createUploadUrl(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `https://storage.e2e.invalid/${key}?signed=1`,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  }

  createDownloadUrl(key: string): Promise<string> {
    return Promise.resolve(`https://storage.e2e.invalid/${key}?download=1`);
  }

  headObject(key: string): Promise<ObjectMetadata | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  upload(input: UploadInput): Promise<void> {
    this.objects.set(input.key, { sizeBytes: Buffer.byteLength(input.body), contentType: input.contentType });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }

  deleteMany(keys: readonly string[]): Promise<void> {
    keys.forEach((key) => this.objects.delete(key));
    this.deleted.push(...keys);
    return Promise.resolve();
  }

  publicUrl(): string | null {
    return null;
  }

  /** What a client's direct upload to the presigned URL would leave behind. */
  putObject(key: string, contentType: string, sizeBytes: number): void {
    this.objects.set(key, { contentType, sizeBytes });
  }
}

/** Stripe stand-in: a fixed catalogue; every create returns ids shaped like Stripe's. */
export class FakePaymentGateway extends PaymentGateway {
  readonly prices: GatewayPrice[] = [
    {
      id: 'price_onetime1',
      productId: 'prod_1',
      productName: 'Sticker pack',
      description: null,
      unitAmount: 500,
      currency: 'usd',
      recurring: null,
    },
    {
      id: 'price_monthly1',
      productId: 'prod_2',
      productName: 'Pro',
      description: 'Pro plan',
      unitAmount: 999,
      currency: 'usd',
      recurring: { interval: 'month', intervalCount: 1 },
    },
  ];
  readonly idempotencyKeys: string[] = [];
  private sequence = 0;

  listPrices(): Promise<GatewayPrice[]> {
    return Promise.resolve(this.prices);
  }

  getPrice(priceId: string): Promise<GatewayPrice | null> {
    return Promise.resolve(this.prices.find((p) => p.id === priceId) ?? null);
  }

  createProductWithPrice(input: NewProduct, key: string): Promise<GatewayPrice> {
    this.idempotencyKeys.push(key);
    const price: GatewayPrice = {
      id: `price_new${(this.sequence += 1)}`,
      productId: `prod_new${this.sequence}`,
      productName: input.name,
      description: input.description ?? null,
      unitAmount: input.unitAmount,
      currency: input.currency,
      recurring: input.interval ? { interval: input.interval, intervalCount: 1 } : null,
    };
    this.prices.push(price);
    return Promise.resolve(price);
  }

  createCustomer(input: { userId: string }, key: string): Promise<string> {
    this.idempotencyKeys.push(key);
    return Promise.resolve(`cus_${input.userId}`);
  }

  createCheckoutSession(_input: CheckoutInput, key: string): Promise<{ id: string; url: string }> {
    this.idempotencyKeys.push(key);
    const id = `cs_test_${(this.sequence += 1)}`;
    return Promise.resolve({ id, url: `https://checkout.stripe.test/${id}` });
  }

  createPaymentIntent(_input: unknown, key: string): Promise<{ id: string; clientSecret: string }> {
    this.idempotencyKeys.push(key);
    const id = `pi_test_${(this.sequence += 1)}`;
    return Promise.resolve({ id, clientSecret: `${id}_secret_x` });
  }

  createPortalSession(): Promise<{ url: string }> {
    return Promise.resolve({ url: 'https://billing.stripe.test/session' });
  }
}

export interface Fakes {
  mail: FakeMail;
  sms: FakeSms;
  push: FakePush;
  storage: FakeStorage;
  payments: FakePaymentGateway;
}

export const createFakes = (): Fakes => ({
  mail: new FakeMail(),
  sms: new FakeSms(),
  push: new FakePush(),
  storage: new FakeStorage(),
  payments: new FakePaymentGateway(),
});
