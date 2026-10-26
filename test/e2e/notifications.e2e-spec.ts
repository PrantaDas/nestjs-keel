import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Role } from '@/common/auth/auth.types';
import { Notifier } from '@/common/contracts/notifier.contract';
import { OutboxRelayModule } from '@/infra/events/events.module';
import { OutboxRelay } from '@/infra/events/outbox-relay';
import { NotificationsJobsModule } from '@/modules/notifications/notifications.module';
import { NotificationsProcessor } from '@/modules/notifications/notifications.processor';
import { createTestApp, TestApp } from './app';
import { API, eventually, PASSWORD, signUp, staffAccount } from './helpers';

/**
 * Push, inbox and the rule that matters most: an account that is deactivated, deletion-pending or
 * deleted receives nothing. The worker side (BullMQ processor, outbox relay) runs inside the test
 * app, against the real Redis queue.
 */
describe('Notifications (e2e)', () => {
  let t: TestApp;
  let deliveries: ReturnType<Connection['collection']>;

  beforeAll(async () => {
    t = await createTestApp({ imports: [NotificationsJobsModule, OutboxRelayModule] });
    deliveries = t.app.get<Connection>(getConnectionToken()).collection('notification_deliveries');
  });

  afterAll(() => t.close());

  const device = (token: string) => ({ label: 'Phone', pushToken: token, platform: 'android', appVersion: '1.0.0' });
  const notify = (userIds: string[], occurrenceKey: string) =>
    t.app.get(Notifier).notifyUsers({ source: 'e2e', occurrenceKey, userIds, title: 'Hello', body: 'From the test' });

  it('registers the device at sign-in and puts it on the default topic', async () => {
    await signUp(t.http, { device: device('token-signin') });
    expect(t.fakes.push.subscribed.get('all')?.has('token-signin')).toBe(true);
  });

  it('delivers a push and an inbox entry, once per occurrence', async () => {
    const me = await signUp(t.http, { device: device('token-once') });
    await notify([me.userId], 'occ-1');
    await notify([me.userId], 'occ-1');
    await eventually(async () => (await deliveries.findOne({ occurrenceKey: 'occ-1', status: 'sent' })) !== null);
    expect(t.fakes.push.sentTo('token-once')).toHaveLength(1);

    const inbox = await t.http.get(`${API}/notifications`).set(me.auth).expect(200);
    expect(inbox.body.data).toEqual([expect.objectContaining({ title: 'Hello', body: 'From the test', read: false })]);
    const unread = await t.http.get(`${API}/notifications/unread-count`).set(me.auth).expect(200);
    expect(unread.body.data.unread).toBe(1);
    await t.http.post(`${API}/notifications/${inbox.body.data[0]._id}/read`).set(me.auth).expect(200);
    expect((await t.http.get(`${API}/notifications/unread-count`).set(me.auth)).body.data.unread).toBe(0);
  });

  it('deletes a token that the push service reports as dead', async () => {
    const me = await signUp(t.http, { device: device('token-dead') });
    t.fakes.push.dead.add('token-dead');
    await notify([me.userId], 'occ-dead');
    const tokens = t.app.get<Connection>(getConnectionToken()).collection('device_tokens');
    await eventually(async () => (await tokens.countDocuments({ token: 'token-dead' })) === 0);
  });

  describe('a deactivated, deletion-pending or deleted account receives nothing', () => {
    it('is left out when the audience is built', async () => {
      const me = await signUp(t.http, { device: device('token-gone') });
      await t.http.post(`${API}/users/me/deactivate`).set(me.auth).send({ password: PASSWORD }).expect(200);
      await expect(notify([me.userId], 'occ-gone')).resolves.toEqual({ queued: 0 });
      expect(t.fakes.push.sentTo('token-gone')).toHaveLength(0);
    });

    it('is checked again right before sending (deactivated after the send was queued)', async () => {
      const worker = t.app.get(NotificationsProcessor).worker;
      await worker.pause();
      try {
        const me = await signUp(t.http, { device: device('token-late'), email: undefined });
        await expect(notify([me.userId], 'occ-late')).resolves.toEqual({ queued: 1 });
        await t.http.post(`${API}/users/me/deletion`).set(me.auth).send({ password: PASSWORD }).expect(200);
        void worker.resume();
        await eventually(
          async () => (await deliveries.findOne({ occurrenceKey: 'occ-late', status: 'skipped' })) !== null,
        );
        expect(t.fakes.push.sentTo('token-late')).toHaveLength(0);
        const inbox = await t.http.get(`${API}/notifications`).set(me.auth).expect(200);
        expect(inbox.body.data).toEqual([]);
        expect(t.fakes.mail.sent.filter((m) => m.subject === 'Hello')).toHaveLength(0);
      } finally {
        void worker.resume();
      }
    });

    it('has its tokens taken off every topic and forgotten (user.deactivated, through the outbox)', async () => {
      const admin = await staffAccount(t.app, t.http, Role.ADMIN);
      const me = await signUp(t.http, { device: device('token-topic') });
      expect(t.fakes.push.subscribed.get('all')?.has('token-topic')).toBe(true);
      await t.http.post(`${API}/admin/users/${me.userId}/disable`).set(admin.auth).expect(200);
      await t.app.get(OutboxRelay).drain();
      expect(t.fakes.push.subscribed.get('all')?.has('token-topic')).toBe(false);
      const tokens = t.app.get<Connection>(getConnectionToken()).collection('device_tokens');
      expect(await tokens.countDocuments({ token: 'token-topic' })).toBe(0);
    });
  });

  describe('browser push (Web Push)', () => {
    const keys = { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) };
    const subscription = (id: string) => ({
      endpoint: `https://push.e2e.test/${id}`,
      expirationTime: null,
      keys,
      label: 'Firefox on Linux',
    });
    const subscriptions = () => t.app.get<Connection>(getConnectionToken()).collection('web_push_subscriptions');

    it('serves the public key without sign-in', async () => {
      const res = await t.http.get(`${API}/notifications/web-push/public-key`).expect(200);
      expect(res.body.data.publicKey).toBe(t.fakes.webPush.publicKey());
    });

    it('registers a browser once, lists it without its address, and delivers to it', async () => {
      const me = await signUp(t.http);
      const first = await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('once'))
        .expect(200);
      expect(first.body.data).toMatchObject({ label: 'Firefox on Linux', service: 'push.e2e.test', expiresAt: null });
      expect(first.body.data).not.toHaveProperty('endpoint');
      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('once'))
        .expect(200);
      const list = await t.http.get(`${API}/notifications/web-push/subscriptions`).set(me.auth).expect(200);
      expect(list.body.data).toHaveLength(1);

      await notify([me.userId], 'occ-web');
      await eventually(async () => (await deliveries.findOne({ occurrenceKey: 'occ-web', status: 'sent' })) !== null);
      expect(t.fakes.webPush.sentTo('https://push.e2e.test/once')).toEqual([
        expect.objectContaining({
          title: 'Hello',
          body: 'From the test',
          subscription: expect.objectContaining({ keys }),
        }),
      ]);
      expect(await deliveries.findOne({ occurrenceKey: 'occ-web' })).toMatchObject({ pushSent: 1, pushFailed: 0 });
    });

    it('refuses push services off the list and malformed subscriptions', async () => {
      const me = await signUp(t.http);
      const refused = await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send({ ...subscription('x'), endpoint: 'https://attacker.example/hook' })
        .expect(400);
      expect(refused.body.errorCode).toBe(4002);
      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send({ ...subscription('y'), keys: { p256dh: 'short', auth: 'short' } })
        .expect(400);
      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send({ ...subscription('z'), endpoint: 'http://push.e2e.test/z' })
        .expect(400);
    });

    it('drops a subscription the push service reports gone', async () => {
      const me = await signUp(t.http);
      await t.http.put(`${API}/notifications/web-push/subscriptions`).set(me.auth).send(subscription('gone'));
      t.fakes.webPush.gone.add('https://push.e2e.test/gone');
      await notify([me.userId], 'occ-web-gone');
      await eventually(
        async () => (await subscriptions().countDocuments({ endpoint: 'https://push.e2e.test/gone' })) === 0,
      );
    });

    it("removes my browsers, never someone else's, and forgets them at sign-out", async () => {
      const me = await signUp(t.http);
      const other = await signUp(t.http);
      const mine = await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('mine'))
        .expect(200);
      await t.http
        .delete(`${API}/notifications/web-push/subscriptions/${mine.body.data._id}`)
        .set(other.auth)
        .expect(404);
      await t.http.delete(`${API}/notifications/web-push/subscriptions/${mine.body.data._id}`).set(me.auth).expect(204);

      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('self'))
        .expect(200);
      await t.http
        .post(`${API}/notifications/web-push/unsubscribe`)
        .set(other.auth)
        .send({ endpoint: 'https://push.e2e.test/self' })
        .expect(200);
      expect(await subscriptions().countDocuments({ endpoint: 'https://push.e2e.test/self' })).toBe(1);
      await t.http
        .post(`${API}/notifications/web-push/unsubscribe`)
        .set(me.auth)
        .send({ endpoint: 'https://push.e2e.test/self' })
        .expect(200);
      expect(await subscriptions().countDocuments({ endpoint: 'https://push.e2e.test/self' })).toBe(0);

      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('session'))
        .expect(200);
      await t.http.post(`${API}/auth/logout`).set(me.auth).expect(200);
      expect(await subscriptions().countDocuments({ endpoint: 'https://push.e2e.test/session' })).toBe(0);
    });

    it('sends a test notification to my own browsers', async () => {
      const me = await signUp(t.http);
      await t.http
        .put(`${API}/notifications/web-push/subscriptions`)
        .set(me.auth)
        .send(subscription('test'))
        .expect(200);
      const res = await t.http.post(`${API}/notifications/web-push/test`).set(me.auth).expect(202);
      expect(res.body.data).toEqual({ queued: 1 });
      await eventually(async () => t.fakes.webPush.sentTo('https://push.e2e.test/test').length === 1);
      const inbox = await t.http.get(`${API}/notifications`).set(me.auth).expect(200);
      expect(inbox.body.data).toEqual([]);
    });
  });

  it('lets staff notify accounts and push to a topic (audited)', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const me = await signUp(t.http, { device: device('token-admin') });
    const res = await t.http
      .post(`${API}/admin/notifications/send`)
      .set(admin.auth)
      .send({ userIds: [me.userId], title: 'Maintenance tonight', channels: ['push', 'inbox'] })
      .expect(202);
    expect(res.body.data).toEqual({ queued: 1 });
    await eventually(async () => t.fakes.push.sentTo('token-admin').length === 1);

    await t.http
      .post(`${API}/admin/notifications/topics/all`)
      .set(admin.auth)
      .send({ title: 'Hello everyone' })
      .expect(202);
    expect(t.fakes.push.topicSends).toEqual([{ topic: 'all', message: { title: 'Hello everyone', body: undefined } }]);
    await t.http
      .post(`${API}/admin/notifications/send`)
      .set(me.auth)
      .send({ userIds: [me.userId], title: 'x' })
      .expect(403);
  });
});
