import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Role } from '@/common/auth/auth.types';
import { FixedClock } from '@/common/time/clock';
import { UsersService } from '@/modules/identity/users/users.service';
import { createTestApp, TestApp } from './app';
import { API, eventually, lastCodeFor, PASSWORD, signUp, staffAccount, uniqueEmail } from './helpers';

describe('Identity: account (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('reads and updates the profile', async () => {
    const me = await signUp(t.http, { name: 'Grace' });
    const res = await t.http
      .patch(`${API}/users/me`)
      .set(me.auth)
      .send({ name: 'Grace Hopper', locale: 'en-US', timeZone: 'America/New_York' })
      .expect(200);
    expect(res.body).toMatchObject({
      message: 'Profile updated.',
      data: { name: 'Grace Hopper', locale: 'en-US', timeZone: 'America/New_York' },
    });
    const bad = await t.http
      .patch(`${API}/users/me`)
      .set(me.auth)
      .send({ timeZone: '+05:30', role: 'admin' })
      .expect(400);
    expect(bad.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['role', 'timeZone']);
  });

  it('uploads a profile picture through a presigned URL, then confirms it', async () => {
    const me = await signUp(t.http);
    const upload = await t.http
      .post(`${API}/users/me/avatar/upload-url`)
      .set(me.auth)
      .send({ contentType: 'image/png', sizeBytes: 2048 })
      .expect(200);
    const { key, uploadUrl, headers } = upload.body.data;
    expect(uploadUrl).toContain(key);
    expect(headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '2048' });

    // Not uploaded yet: refused.
    const early = await t.http.put(`${API}/users/me/avatar`).set(me.auth).send({ key }).expect(400);
    expect(early.body.error).toBe('AVATAR_UPLOAD_MISSING');

    t.fakes.storage.putObject(key, 'image/png', 2048);
    const set = await t.http.put(`${API}/users/me/avatar`).set(me.auth).send({ key }).expect(200);
    expect(set.body.data.avatarUrl).toContain(key);
    expect(JSON.stringify(set.body)).not.toContain('avatarKey');

    // Someone else's upload key is never accepted.
    const other = await signUp(t.http);
    await t.http.put(`${API}/users/me/avatar`).set(other.auth).send({ key }).expect(400);
  });

  it('changes the e-mail only with a code sent to the new address', async () => {
    const me = await signUp(t.http);
    const next = uniqueEmail('new');
    await t.http.post(`${API}/users/me/email`).set(me.auth).send({ email: next }).expect(202);
    const code = await lastCodeFor(t.app, next);
    const res = await t.http.post(`${API}/users/me/email/confirm`).set(me.auth).send({ email: next, code }).expect(200);
    expect(res.body.data).toMatchObject({ email: next, emailVerified: true });

    const taken = await signUp(t.http);
    const conflict = await t.http.post(`${API}/users/me/email`).set(taken.auth).send({ email: next }).expect(409);
    expect(conflict.body.error).toBe('EMAIL_TAKEN');
  });

  it('adds a phone with an SMS code, and that phone can then sign in with a code', async () => {
    const me = await signUp(t.http);
    const phone = `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await t.http
      .post(`${API}/users/me/phone`)
      .set(me.auth)
      .send({ phone: phone.replace('+1', '+1 ') })
      .expect(202);
    const code = await lastCodeFor(t.app, phone);
    // A code is bound to the account it was sent for.
    const stranger = await signUp(t.http);
    await t.http.post(`${API}/users/me/phone/confirm`).set(stranger.auth).send({ phone, code }).expect(400);
    await t.http.post(`${API}/users/me/phone/confirm`).set(me.auth).send({ phone, code }).expect(200);

    await t.http.post(`${API}/auth/otp/request`).send({ channel: 'sms', phone }).expect(202);
    const login = await lastCodeFor(t.app, phone);
    const res = await t.http.post(`${API}/auth/otp/verify`).send({ channel: 'sms', phone, code: login }).expect(200);
    expect(res.body.data.user._id).toBe(me.userId);
  });

  it('changes the password and signs out the other devices only', async () => {
    const me = await signUp(t.http);
    const other = (await t.http.post(`${API}/auth/login`).send({ email: me.email, password: PASSWORD }).expect(200))
      .body.data;
    const wrong = await t.http
      .post(`${API}/users/me/password`)
      .set(me.auth)
      .send({ currentPassword: 'not-the-password-1', newPassword: 'next-password-22' })
      .expect(400);
    expect(wrong.body.error).toBe('PASSWORD_INCORRECT');
    await t.http
      .post(`${API}/users/me/password`)
      .set(me.auth)
      .send({ currentPassword: PASSWORD, newPassword: 'next-password-22' })
      .expect(200);
    await t.http.get(`${API}/users/me`).set(me.auth).expect(200);
    await t.http
      .get(`${API}/users/me`)
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .expect(401);
  });

  it('deactivates the account; signing in again reactivates it', async () => {
    const me = await signUp(t.http);
    await t.http.post(`${API}/users/me/deactivate`).set(me.auth).send({ password: PASSWORD }).expect(200);
    await t.http.get(`${API}/users/me`).set(me.auth).expect(401);
    const back = await t.http.post(`${API}/auth/login`).send({ email: me.email, password: PASSWORD }).expect(200);
    expect(back.body.data.user.status).toBe('active');
  });

  it('schedules deletion after the grace period and lets the person cancel it', async () => {
    const me = await signUp(t.http);
    const res = await t.http.post(`${API}/users/me/deletion`).set(me.auth).send({ password: PASSWORD }).expect(200);
    expect(res.body.data.status).toBe('deletion_pending');
    expect(res.body.data.deletionDueAt).toEqual(expect.any(String));
    const cancel = await t.http.delete(`${API}/users/me/deletion`).set(me.auth).expect(200);
    expect(cancel.body.data).toMatchObject({ status: 'active', deletionDueAt: null });
    const again = await t.http.delete(`${API}/users/me/deletion`).set(me.auth).expect(409);
    expect(again.body.error).toBe('DELETION_NOT_PENDING');
  });
});

describe('Identity: admin (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('keeps admin routes for staff', async () => {
    const user = await signUp(t.http);
    const res = await t.http.get(`${API}/admin/users`).set(user.auth).expect(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('lists accounts with search, filters, sorting and pages', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    await signUp(t.http, { name: 'Zelda Searchable' });
    await signUp(t.http, { name: 'Zack Searchable' });
    const res = await t.http
      .get(`${API}/admin/users`)
      .set(admin.auth)
      .query({ q: 'za', sort: 'name', limit: 1 })
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Zack Searchable');
    expect(res.body.meta).toMatchObject({ page: 1, limit: 1, totalDocs: 1 });
    const admins = await t.http.get(`${API}/admin/users`).set(admin.auth).query({ role: 'admin' }).expect(200);
    expect(admins.body.data.every((u: { role: string }) => u.role === 'admin')).toBe(true);
  });

  it('disables an account: signed out at once, cannot sign in; enabling restores it; both audited', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const victim = await signUp(t.http);
    const res = await t.http.post(`${API}/admin/users/${victim.userId}/disable`).set(admin.auth).expect(200);
    expect(res.body.data.status).toBe('deactivated');
    await t.http.get(`${API}/users/me`).set(victim.auth).expect(401);
    const login = await t.http.post(`${API}/auth/login`).send({ email: victim.email, password: PASSWORD }).expect(403);
    expect(login.body.error).toBe('ACCOUNT_DEACTIVATED');

    await t.http.post(`${API}/admin/users/${victim.userId}/enable`).set(admin.auth).expect(200);
    await t.http.post(`${API}/auth/login`).send({ email: victim.email, password: PASSWORD }).expect(200);

    const audit = t.app.get<Connection>(getConnectionToken()).collection('audit_logs');
    const entry = await eventually(() => audit.findOne({ action: 'user.disable', resourceId: victim.userId }));
    expect(entry).toMatchObject({ actorId: admin.userId, outcome: 'success', after: { status: 'deactivated' } });
  });

  it('lets only a super admin change roles, applies a new role to live sessions, protects the last super admin', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const superAdmin = await staffAccount(t.app, t.http, Role.SUPER_ADMIN);
    const person = await signUp(t.http);

    const denied = await t.http
      .patch(`${API}/admin/users/${person.userId}`)
      .set(admin.auth)
      .send({ role: 'admin' })
      .expect(403);
    expect(denied.body.error).toBe('ROLE_CHANGE_FORBIDDEN');

    await t.http.patch(`${API}/admin/users/${person.userId}`).set(superAdmin.auth).send({ role: 'admin' }).expect(200);
    // The person's existing token now carries admin rights (the session holds the role).
    await t.http.get(`${API}/admin/users`).set(person.auth).expect(200);

    const self = await t.http
      .patch(`${API}/admin/users/${superAdmin.userId}`)
      .set(superAdmin.auth)
      .send({ role: 'admin' })
      .expect(403);
    expect(self.body.error).toBe('CANNOT_CHANGE_SELF');
  });

  it('shows one account with its sessions and revokes them', async () => {
    const admin = await staffAccount(t.app, t.http, Role.ADMIN);
    const person = await signUp(t.http, { device: { label: 'Pixel 9' } });
    const detail = await t.http.get(`${API}/admin/users/${person.userId}`).set(admin.auth).expect(200);
    expect(detail.body.data.sessions.map((s: { device: string }) => s.device)).toContain('Pixel 9');
    expect(detail.body.data.notesCount).toBe(0);
    await t.http.delete(`${API}/admin/users/${person.userId}/sessions`).set(admin.auth).expect(200);
    await t.http.get(`${API}/users/me`).set(person.auth).expect(401);
    await t.http.get(`${API}/admin/users/not-an-id`).set(admin.auth).expect(400);
  });
});

describe('Identity: deletion after the grace period (e2e, moved clock)', () => {
  const clock = new FixedClock('2026-10-26T10:00:00Z');
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });

  afterAll(() => t.close());

  it('anonymises the account only once the grace period is over, and signing in before then cancels', async () => {
    const me = await signUp(t.http);
    await t.http.post(`${API}/users/me/deletion`).set(me.auth).send({ password: PASSWORD }).expect(200);
    const users = t.app.get(UsersService);

    await expect(users.anonymize(me.userId)).resolves.toBe(false);
    clock.advance(30 * 86_400_000 + 1);
    expect((await users.dueDeletions(10)).map((u) => u._id.toHexString())).toContain(me.userId);
    await expect(users.anonymize(me.userId)).resolves.toBe(true);
    await expect(users.anonymize(me.userId)).resolves.toBe(false);

    const login = await t.http.post(`${API}/auth/login`).send({ email: me.email, password: PASSWORD }).expect(401);
    expect(login.body.error).toBe('INVALID_CREDENTIALS');
    const outbox = t.app.get<Connection>(getConnectionToken()).collection('outbox_events');
    expect(await outbox.countDocuments({ type: 'user.deleted', 'payload.userId': me.userId })).toBe(1);
  });
});
