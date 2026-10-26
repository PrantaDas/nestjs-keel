import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import Stripe from 'stripe';
import { Role } from '@/common/auth/auth.types';
import { NotificationsJobsModule } from '@/modules/notifications/notifications.module';
import { PaymentsJobsModule } from '@/modules/payments/payments.module';
import { createTestApp, TestApp } from './app';
import { API, eventually, signUp, staffAccount } from './helpers';

const WEBHOOK = '/api/webhooks/stripe';

/**
 * Payments: checkout and payment intents through the (fake) gateway, and the webhook with a REAL
 * signature check over the raw body, idempotent by event id, applied by the worker through the queue.
 */
describe('Payments (e2e)', () => {
  let t: TestApp;
  let raw: Connection;

  beforeAll(async () => {
    t = await createTestApp({ imports: [PaymentsJobsModule.forRoot(), NotificationsJobsModule] });
    raw = t.app.get<Connection>(getConnectionToken());
  });

  afterAll(() => t.close());

  /** A webhook as Stripe sends it: JSON bytes plus a signature over exactly those bytes. */
  function signed(event: object) {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return { payload, header };
  }

  const event = (id: string, type: string, object: object) => ({
    id,
    object: 'event',
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });

  it('lists prices and starts a checkout, creating the customer once', async () => {
    const me = await signUp(t.http);
    const prices = await t.http.get(`${API}/payments/prices`).set(me.auth).expect(200);
    expect(prices.body.data.map((p: { id: string }) => p.id)).toEqual(['price_onetime1', 'price_monthly1']);

    const checkout = await t.http
      .post(`${API}/payments/checkout`)
      .set(me.auth)
      .send({ priceId: 'price_monthly1', mode: 'subscription' })
      .expect(201);
    expect(checkout.body.data.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    await t.http
      .post(`${API}/payments/checkout`)
      .set(me.auth)
      .send({ priceId: 'price_onetime1', mode: 'payment' })
      .expect(201);
    expect(await raw.collection('billing_customers').countDocuments({})).toBe(1);

    const wrong = await t.http
      .post(`${API}/payments/checkout`)
      .set(me.auth)
      .send({ priceId: 'price_onetime1', mode: 'subscription' })
      .expect(400);
    expect(wrong.body.error).toBe('WRONG_PRICE_TYPE');
    const missing = await t.http
      .post(`${API}/payments/checkout`)
      .set(me.auth)
      .send({ priceId: 'price_doesnotexist', mode: 'payment' })
      .expect(404);
    expect(missing.body.error).toBe('PRICE_NOT_FOUND');
  });

  it('refuses a webhook whose signature does not match its body', async () => {
    const { payload, header } = signed(event('evt_forged', 'payment_intent.succeeded', { id: 'pi_x' }));
    const tampered = payload.replace('pi_x', 'pi_y');
    const res = await t.http
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(tampered)
      .expect(400);
    expect(res.body.error).toBe('INVALID_SIGNATURE');
    await t.http.post(WEBHOOK).set('Content-Type', 'application/json').send(payload).expect(400);
  });

  it('marks a payment paid from a verified webhook, once, and tells the person', async () => {
    const me = await signUp(t.http, { device: { pushToken: 'token-paid', platform: 'android' } });
    const intent = await t.http
      .post(`${API}/payments/payment-intents`)
      .set(me.auth)
      .send({ priceId: 'price_onetime1' })
      .expect(201);
    const intentId = intent.body.data.paymentIntentId as string;

    const { payload, header } = signed(
      event('evt_paid_1', 'payment_intent.succeeded', { id: intentId, metadata: { userId: me.userId } }),
    );
    const first = await t.http
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(200);
    expect(first.body).toEqual({ received: true, duplicate: false });
    // Stripe retries the same event: acknowledged, nothing done twice.
    const again = await t.http
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(200);
    expect(again.body).toEqual({ received: true, duplicate: true });

    await eventually(
      async () =>
        (await raw.collection('payment_events').findOne({ eventId: 'evt_paid_1', status: 'processed' })) !== null,
    );
    const billing = await t.http.get(`${API}/payments/me`).set(me.auth).expect(200);
    expect(billing.body.data.payments).toEqual([expect.objectContaining({ status: 'paid', amount: 500 })]);
    await eventually(async () => t.fakes.push.sentTo('token-paid').length === 1);
    expect(t.fakes.push.sentTo('token-paid')[0].title).toBe('Payment received');
  });

  it('keeps the newest subscription state when events arrive out of order', async () => {
    const me = await signUp(t.http);
    await t.http
      .post(`${API}/payments/checkout`)
      .set(me.auth)
      .send({ priceId: 'price_monthly1', mode: 'subscription' })
      .expect(201);
    const subscription = (status: string) => ({
      id: 'sub_1',
      customer: `cus_${me.userId}`,
      status,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_monthly1' }, current_period_end: 1_800_000_000 }] },
    });
    const newer = { ...event('evt_sub_new', 'customer.subscription.updated', subscription('active')), created: 2_000 };
    const older = {
      ...event('evt_sub_old', 'customer.subscription.created', subscription('incomplete')),
      created: 1_000,
    };
    for (const e of [newer, older]) {
      const { payload, header } = signed(e);
      await t.http
        .post(WEBHOOK)
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', header)
        .send(payload)
        .expect(200);
    }
    await eventually(
      async () =>
        (await raw.collection('payment_events').countDocuments({ eventId: /^evt_sub_/, status: 'processed' })) === 2,
    );
    const billing = await t.http.get(`${API}/payments/me`).set(me.auth).expect(200);
    expect(billing.body.data.subscription).toMatchObject({ status: 'active', priceId: 'price_monthly1' });
  });

  it('lets only staff with the payments permission create products', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const root = await staffAccount(t.app, t.http, Role.SUPER_ADMIN);
    const body = { name: 'Team plan', unitAmount: 4900, currency: 'usd', interval: 'month' };
    await t.http.post(`${API}/admin/payments/products`).set(admin.auth).send(body).expect(403);
    const res = await t.http.post(`${API}/admin/payments/products`).set(root.auth).send(body).expect(201);
    expect(res.body.data).toMatchObject({
      productName: 'Team plan',
      unitAmount: 4900,
      recurring: { interval: 'month' },
    });
  });
});
