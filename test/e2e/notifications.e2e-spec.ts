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
