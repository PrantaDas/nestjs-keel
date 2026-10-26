import { getQueueToken } from '@nestjs/bullmq';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import { Role } from '@/common/auth/auth.types';
import { HeartbeatService } from '@/infra/heartbeat/heartbeat.service';
import { QueueName } from '@/infra/queue/queue.constants';
import { createTestApp, TestApp } from './app';
import { API, staffAccount } from './helpers';

/** The ops API: queue counts, failed jobs (retry / discard by super admins only), processes, parked events. */
describe('Ops (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  /** A job that failed for good, without running a worker: moved to failed by hand. */
  async function failedJob(): Promise<string> {
    const queue = t.app.get<Queue>(getQueueToken(QueueName.NOTES), { strict: false });
    const job = await queue.add('reminder', { noteId: 'x', remindAt: 'y' }, { attempts: 1 });
    const worker = await import('bullmq').then(
      ({ Worker }) =>
        new Worker(QueueName.NOTES, async () => Promise.reject(new Error('boom: token=abc123')), {
          connection: queue.opts.connection,
          prefix: queue.opts.prefix,
          autorun: true,
        }),
    );
    for (let i = 0; i < 100 && (await job.getState()) !== 'failed'; i += 1) await new Promise((r) => setTimeout(r, 30));
    await worker.close();
    return String(job.id);
  }

  it('lists queues for staff with read access, and lets only super admins retry or discard', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const root = await staffAccount(t.app, t.http, Role.SUPER_ADMIN);
    const jobId = await failedJob();

    const overview = await t.http.get(`${API}/admin/ops/queues`).set(admin.auth).expect(200);
    expect(overview.body.data.find((q: { name: string }) => q.name === QueueName.NOTES)).toMatchObject({
      owner: 'examples',
      enabled: true,
      counts: { failed: 1 },
    });
    // The e2e environment sets a Stripe key, so the payments queue is part of this deployment.
    expect(overview.body.data.find((q: { name: string }) => q.name === QueueName.STRIPE_EVENTS)).toMatchObject({
      enabled: true,
    });

    const failed = await t.http.get(`${API}/admin/ops/queues/${QueueName.NOTES}/failed`).set(admin.auth).expect(200);
    expect(failed.body.data[0]).toMatchObject({ id: jobId, name: 'reminder' });
    expect(JSON.stringify(failed.body)).not.toContain('abc123');
    expect(JSON.stringify(failed.body)).not.toContain('noteId');

    await t.http.post(`${API}/admin/ops/queues/${QueueName.NOTES}/failed/${jobId}/retry`).set(admin.auth).expect(403);
    const retried = await t.http
      .post(`${API}/admin/ops/queues/${QueueName.NOTES}/failed/${jobId}/retry`)
      .set(root.auth)
      .expect(200);
    expect(retried.body.data).toMatchObject({ id: jobId, state: 'waiting' });
    const again = await t.http
      .delete(`${API}/admin/ops/queues/${QueueName.NOTES}/failed/${jobId}`)
      .set(root.auth)
      .expect(409);
    expect(again.body.error).toBe('OPS_JOB_NOT_FAILED');
    await t.http.get(`${API}/admin/ops/queues/no-such-queue/failed`).set(admin.auth).expect(404);
  });

  it('lists running processes from their heartbeats', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    await t.app.get(HeartbeatService).beat();
    const res = await t.http.get(`${API}/admin/ops/processes`).set(admin.auth).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'api' })]));
  });

  it('shows parked outbox events and delivers one again on request', async () => {
    const root = await staffAccount(t.app, t.http, Role.SUPER_ADMIN);
    const outbox = t.app.get<Connection>(getConnectionToken()).collection('outbox_events');
    await outbox.insertOne({
      eventId: '0b6c2f5e-6d1a-4b8f-9f0e-3a2b1c4d5e6f',
      type: 'user.deactivated',
      payload: { userId: 'secret-user' },
      occurredAt: new Date(),
      status: 'failed',
      attempts: 10,
      availableAt: new Date(),
      lockedUntil: null,
      claimToken: null,
      lastError: 'handler failed',
    });
    const list = await t.http.get(`${API}/admin/ops/outbox/failed`).set(root.auth).expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ type: 'user.deactivated', attempts: 10 })]);
    expect(JSON.stringify(list.body)).not.toContain('secret-user');
    await t.http.post(`${API}/admin/ops/outbox/0b6c2f5e-6d1a-4b8f-9f0e-3a2b1c4d5e6f/retry`).set(root.auth).expect(200);
    expect(await outbox.findOne({ eventId: '0b6c2f5e-6d1a-4b8f-9f0e-3a2b1c4d5e6f' })).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });
});
