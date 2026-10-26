import { FixedClock } from '@/common/time/clock';
import { otpConfig } from '@/config/configuration';
import { createTestApp, TestApp } from './app';
import { API, bearer, lastCodeFor, PASSWORD, signUp, uniqueEmail } from './helpers';

/**
 * Sign-up, password and code sign-in, token rotation with reuse detection, sessions and sign-out,
 * password reset and e-mail verification, against real MongoDB and Redis.
 */
describe('Identity: auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  describe('sign-up and password sign-in', () => {
    it('registers, signs in at once and queues an e-mail confirmation code', async () => {
      const email = uniqueEmail('signup');
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Lovelace', email: email.toUpperCase(), password: PASSWORD })
        .expect(201);
      expect(res.body).toMatchObject({
        success: true,
        data: { user: { email, emailVerified: false, role: 'user', status: 'active', hasPassword: true } },
      });
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt/);
      await expect(lastCodeFor(t.app, email)).resolves.toMatch(/^\d{6}$/);
    });

    it('refuses a second account with the same e-mail', async () => {
      const { email } = await signUp(t.http);
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ name: 'Copy', email, password: PASSWORD })
        .expect(409);
      expect(res.body).toMatchObject({ error: 'EMAIL_TAKEN', errorCode: 3000 });
    });

    it('validates input with human messages', async () => {
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ name: '', email: 'nope', password: 'short' })
        .expect(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'email', message: 'Enter a valid email address.' },
          { field: 'password', message: 'Password must be at least 10 characters and include a letter and a number.' },
        ]),
      );
    });

    it('answers a wrong password and an unknown e-mail the same way', async () => {
      const { email } = await signUp(t.http);
      const wrong = await t.http.post(`${API}/auth/login`).send({ email, password: 'wrong-password-1' }).expect(401);
      const unknown = await t.http
        .post(`${API}/auth/login`)
        .send({ email: uniqueEmail('ghost'), password: 'wrong-password-1' })
        .expect(401);
      expect(wrong.body.error).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.error).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.errorMessage).toBe(unknown.body.errorMessage);
    });

    it('locks the account after repeated failures, even for the right password', async () => {
      const { email } = await signUp(t.http);
      for (let i = 0; i < 4; i += 1) {
        await t.http.post(`${API}/auth/login`).send({ email, password: 'wrong-password-1' }).expect(401);
      }
      const locked = await t.http.post(`${API}/auth/login`).send({ email, password: 'wrong-password-1' }).expect(429);
      expect(locked.body.error).toBe('ACCOUNT_LOCKED');
      const right = await t.http.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(429);
      expect(right.body.error).toBe('ACCOUNT_LOCKED');
    });
  });

  describe('tokens and sessions', () => {
    it('rotates the refresh token: the new one works, the old one is spent', async () => {
      const me = await signUp(t.http);
      const first = await t.http.post(`${API}/auth/refresh`).send({ refreshToken: me.refreshToken }).expect(200);
      expect(first.body.data.refreshToken).not.toBe(me.refreshToken);
      await t.http.get(`${API}/users/me`).set(bearer(first.body.data.accessToken)).expect(200);
      await t.http.post(`${API}/auth/refresh`).send({ refreshToken: first.body.data.refreshToken }).expect(200);
    });

    it('detects reuse of a rotated refresh token and revokes the whole session', async () => {
      const me = await signUp(t.http);
      const rotated = await t.http.post(`${API}/auth/refresh`).send({ refreshToken: me.refreshToken }).expect(200);

      // A thief replays the old token: the session ends for both the thief and the owner.
      const reuse = await t.http.post(`${API}/auth/refresh`).send({ refreshToken: me.refreshToken }).expect(401);
      expect(reuse.body.error).toBe('REFRESH_TOKEN_REUSED');
      const owner = await t.http
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(401);
      expect(owner.body.error).toBe('INVALID_REFRESH_TOKEN');
      const access = await t.http.get(`${API}/users/me`).set(bearer(rotated.body.data.accessToken)).expect(401);
      expect(access.body.error).toBe('SESSION_REVOKED');
    });

    it('rejects tampered and foreign tokens', async () => {
      const me = await signUp(t.http);
      const [header, payload, signature] = me.accessToken.split('.');
      const tampered = `${header}.${payload.slice(0, -2)}xx.${signature}`;
      await t.http.get(`${API}/users/me`).set(bearer(tampered)).expect(401);
      const res = await t.http.post(`${API}/auth/refresh`).send({ refreshToken: me.accessToken }).expect(401);
      expect(res.body.error).toBe('INVALID_REFRESH_TOKEN');
    });

    it('signs out one device at once, and everywhere', async () => {
      const { email } = await signUp(t.http);
      const login = () =>
        t.http.post(`${API}/auth/login`).send({ email, password: PASSWORD, device: { label: 'Tablet' } });
      const a = (await login().expect(200)).body.data;
      const b = (await login().expect(200)).body.data;

      const sessions = await t.http.get(`${API}/auth/sessions`).set(bearer(a.accessToken)).expect(200);
      expect(sessions.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(sessions.body.data.map((s: { device: string }) => s.device)).toContain('Tablet');

      await t.http.post(`${API}/auth/logout`).set(bearer(a.accessToken)).expect(200);
      await t.http.get(`${API}/users/me`).set(bearer(a.accessToken)).expect(401);
      await t.http.get(`${API}/users/me`).set(bearer(b.accessToken)).expect(200);

      const all = await t.http.post(`${API}/auth/logout-all`).set(bearer(b.accessToken)).expect(200);
      expect(all.body.data.revoked).toBeGreaterThanOrEqual(2);
      await t.http.get(`${API}/users/me`).set(bearer(b.accessToken)).expect(401);
    });

    it('revokes another device from the session list', async () => {
      const { email } = await signUp(t.http);
      const other = (await t.http.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200)).body.data;
      const mine = (await t.http.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200)).body.data;
      await t.http.delete(`${API}/auth/sessions/${other.sessionId}`).set(bearer(mine.accessToken)).expect(204);
      await t.http.get(`${API}/users/me`).set(bearer(other.accessToken)).expect(401);
      const again = await t.http
        .delete(`${API}/auth/sessions/${other.sessionId}`)
        .set(bearer(mine.accessToken))
        .expect(404);
      expect(again.body.error).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('sign-in with a one-time code', () => {
    it('gives the same answer whether or not an account exists, and sends only to real accounts', async () => {
      const { email } = await signUp(t.http);
      const ghost = uniqueEmail('ghost');
      const known = await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(202);
      const unknown = await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email: ghost }).expect(202);
      expect(known.body).toEqual({ ...unknown.body });
      await expect(lastCodeFor(t.app, ghost)).rejects.toThrow(/No code queued/);
      await expect(lastCodeFor(t.app, email)).resolves.toMatch(/^\d{6}$/);
    });

    it('signs in with the code, marks the address verified, and the code works once', async () => {
      const { email } = await signUp(t.http);
      await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(202);
      const code = await lastCodeFor(t.app, email);
      const res = await t.http.post(`${API}/auth/otp/verify`).send({ channel: 'email', email, code }).expect(200);
      expect(res.body.data.user).toMatchObject({ email, emailVerified: true });
      const again = await t.http.post(`${API}/auth/otp/verify`).send({ channel: 'email', email, code }).expect(400);
      expect(again.body.error).toBe('OTP_INVALID');
    });

    it('a wrong code fails; too many wrong codes burn the code', async () => {
      const { email } = await signUp(t.http);
      await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(202);
      const code = await lastCodeFor(t.app, email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const res = await t.http
          .post(`${API}/auth/otp/verify`)
          .send({ channel: 'email', email, code: wrong })
          .expect(400);
        expect(res.body.error).toBe('OTP_INVALID');
      }
      const burnt = await t.http.post(`${API}/auth/otp/verify`).send({ channel: 'email', email, code });
      expect([400, 429]).toContain(burnt.status);
      expect(['OTP_INVALID', 'OTP_TOO_MANY_ATTEMPTS']).toContain(burnt.body.error);
    });

    it('limits codes per recipient per hour (the SMS bill cannot be run up)', async () => {
      const { email } = await signUp(t.http);
      // Sign-up already sent one confirmation code to this address; the hourly budget is 5.
      for (let i = 0; i < 4; i += 1) {
        await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(202);
      }
      const res = await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(429);
      expect(res.body.error).toBe('OTP_SEND_LIMIT');
    });

    it('requires the address that matches the channel', async () => {
      const res = await t.http.post(`${API}/auth/otp/request`).send({ channel: 'sms' }).expect(400);
      expect(res.body.details).toEqual([{ field: 'phone', message: 'Phone number is required.' }]);
    });
  });

  describe('password reset and e-mail verification', () => {
    it('resets the password with an e-mailed code and signs out every device', async () => {
      const me = await signUp(t.http);
      await t.http.post(`${API}/auth/password/forgot`).send({ email: me.email }).expect(202);
      const code = await lastCodeFor(t.app, me.email);
      await t.http
        .post(`${API}/auth/password/reset`)
        .send({ email: me.email, code, newPassword: 'a-brand-new-pass-9' })
        .expect(200);
      await t.http.get(`${API}/users/me`).set(me.auth).expect(401);
      await t.http.post(`${API}/auth/login`).send({ email: me.email, password: PASSWORD }).expect(401);
      await t.http.post(`${API}/auth/login`).send({ email: me.email, password: 'a-brand-new-pass-9' }).expect(200);
    });

    it('confirms the account address with the code sent at sign-up', async () => {
      const me = await signUp(t.http);
      const code = await lastCodeFor(t.app, me.email);
      const res = await t.http.post(`${API}/auth/email/verify`).set(me.auth).send({ code }).expect(200);
      expect(res.body.data.emailVerified).toBe(true);
      const twice = await t.http.post(`${API}/auth/email/verify/request`).set(me.auth).expect(409);
      expect(twice.body.error).toBe('EMAIL_ALREADY_VERIFIED');
    });
  });
});

describe('Identity: code expiry (e2e, frozen clock)', () => {
  const clock = new FixedClock('2026-10-26T10:00:00Z');
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });

  afterAll(() => t.close());

  it('refuses a code after OTP_TTL_SECONDS, measured on the injected clock', async () => {
    const { email } = await signUp(t.http);
    await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email }).expect(202);
    const code = await lastCodeFor(t.app, email);
    clock.advance(5 * 60_000 + 1);
    const res = await t.http.post(`${API}/auth/otp/verify`).send({ channel: 'email', email, code }).expect(400);
    expect(res.body.error).toBe('OTP_INVALID');
  });

  it('expires access tokens on the injected clock (refresh still works)', async () => {
    const me = await signUp(t.http);
    clock.advance(15 * 60_000 + 10_000);
    const expired = await t.http.get(`${API}/users/me`).set(me.auth).expect(401);
    expect(expired.body.error).toBe('TOKEN_EXPIRED');
    await t.http.post(`${API}/auth/refresh`).send({ refreshToken: me.refreshToken }).expect(200);
  });
});

describe('Identity: code resend cool-down (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(otpConfig.KEY).useValue({
          length: 6,
          ttlSeconds: 300,
          maxAttempts: 5,
          resendCooldownSeconds: 60,
          maxSendsPerHour: 5,
          maxVerifiesPerHour: 15,
          devLog: false,
        }),
    });
  });

  afterAll(() => t.close());

  it('refuses a second code inside the cool-down, for known and unknown addresses alike', async () => {
    const { email } = await signUp(t.http);
    for (const address of [email, uniqueEmail('ghost')]) {
      await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email: address }).expect(202);
      const res = await t.http.post(`${API}/auth/otp/request`).send({ channel: 'email', email: address }).expect(429);
      expect(res.body.error).toBe('OTP_RESEND_TOO_SOON');
    }
  });
});
