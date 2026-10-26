import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, TestApp } from './app';
import { API, E2E_API_KEY, signUp } from './helpers';

/**
 * Cross-cutting HTTP contract on real routes: envelopes, request ids, server time, body parsing and
 * limits, input sanitising, idempotency keys, API keys, health and readiness.
 */
describe('API contract (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  describe('envelopes and headers', () => {
    it('serves version-neutral health and readiness with the success envelope', async () => {
      const health = await t.http.get('/api/health').expect(200);
      expect(health.body).toMatchObject({ success: true, message: 'Service is running.', data: { status: 'ok' } });
      const ready = await t.http.get('/api/ready').expect(200);
      expect(ready.body.data.details).toMatchObject({ mongodb: { status: 'up' }, redisCore: { status: 'up' } });
    });

    it('echoes a safe request id, stamps server time, and puts the id in error bodies', async () => {
      const res = await t.http.get(`${API}/users/me`).set('x-request-id', 'trace-abc-12345').expect(401);
      expect(res.headers['x-request-id']).toBe('trace-abc-12345');
      expect(Date.parse(res.headers['x-server-time'])).not.toBeNaN();
      expect(res.body).toEqual({
        success: false,
        errorCode: 1000,
        error: 'MISSING_BEARER_TOKEN',
        errorMessage: 'Please sign in to continue.',
        requestId: 'trace-abc-12345',
      });
    });

    it('answers unknown routes, broken JSON and oversized bodies with the error envelope', async () => {
      const me = await signUp(t.http);
      expect((await t.http.get(`${API}/does-not-exist`).set(me.auth).expect(404)).body.error).toBe('ROUTE_NOT_FOUND');
      const broken = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .set('Content-Type', 'application/json')
        .send('{"title":')
        .expect(400);
      expect(broken.body.error).toBe('MALFORMED_JSON');
      const huge = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .send({ title: 'x', body: 'y'.repeat(1_100_000) })
        .expect(413);
      expect(huge.body.error).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('strips operator keys from input (NoSQL injection), before validation sees them', async () => {
    const res = await t.http
      .post(`${API}/auth/login`)
      .send({ email: { $gt: '' }, password: { $ne: null } })
      .expect(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('$gt');
  });

  describe('Idempotency-Key', () => {
    it('replays the first answer for a repeat, without running the handler again', async () => {
      const me = await signUp(t.http);
      const send = () =>
        t.http.post(`${API}/notes`).set(me.auth).set('Idempotency-Key', 'create-note-0001').send({ title: 'Once' });
      const first = await send().expect(201);
      const second = await send().expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data._id).toBe(first.body.data._id);
      const notes = t.app.get<Connection>(getConnectionToken()).collection('notes');
      expect(await notes.countDocuments({ title: 'Once' })).toBe(1);
    });

    it('refuses the same key with a different body, and malformed keys', async () => {
      const me = await signUp(t.http);
      await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .set('Idempotency-Key', 'create-note-0002')
        .send({ title: 'A' })
        .expect(201);
      const reused = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .set('Idempotency-Key', 'create-note-0002')
        .send({ title: 'B' })
        .expect(422);
      expect(reused.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      const bad = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .set('Idempotency-Key', 'no')
        .send({ title: 'C' })
        .expect(400);
      expect(bad.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('scopes keys to the caller: another account with the same key is a new request', async () => {
      const a = await signUp(t.http);
      const b = await signUp(t.http);
      const first = await t.http
        .post(`${API}/notes`)
        .set(a.auth)
        .set('Idempotency-Key', 'shared-key-0003')
        .send({ title: 'X' })
        .expect(201);
      const other = await t.http
        .post(`${API}/notes`)
        .set(b.auth)
        .set('Idempotency-Key', 'shared-key-0003')
        .send({ title: 'X' })
        .expect(201);
      expect(other.body.data._id).not.toBe(first.body.data._id);
    });
  });

  describe('API keys (machine clients)', () => {
    it('accepts a configured key and refuses a missing or wrong one, without a user token', async () => {
      const me = await signUp(t.http);
      const body = { userIds: [me.userId], title: 'From another service' };
      const ok = await t.http
        .post(`${API}/internal/notifications`)
        .set('x-api-key', E2E_API_KEY)
        .send(body)
        .expect(202);
      expect(ok.body.data).toEqual({ queued: 1 });
      const wrong = await t.http.post(`${API}/internal/notifications`).set('x-api-key', 'nope').send(body).expect(401);
      expect(wrong.body.error).toBe('INVALID_API_KEY');
      // A user token is not an API key.
      await t.http.post(`${API}/internal/notifications`).set(me.auth).send(body).expect(401);
    });
  });
});
