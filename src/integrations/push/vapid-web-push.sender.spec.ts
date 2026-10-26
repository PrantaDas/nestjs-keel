import { createECDH, randomBytes } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { integrationBreakers } from '@/integrations/resilience/circuit-breaker';
import { VapidWebPushSender } from './vapid-web-push.sender';
import { WEB_PUSH_CONCURRENCY, type WebPushDelivery } from './web-push.port';

const vapid = generateVAPIDKeys();
const ALLOWED = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com'];

const config = (keys: { publicKey: string; privateKey: string } = vapid) => ({
  webPush: { ...keys, subject: 'mailto:ops@example.com', ttlSeconds: 3600, allowedHosts: ALLOWED },
});

/** A real browser key pair, so the payload is encrypted exactly as for a browser. */
function browserKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

const delivery = (endpoint: string, extra: Partial<WebPushDelivery> = {}): WebPushDelivery => ({
  subscription: { endpoint, keys: browserKeys() },
  title: 'Hello',
  body: 'From the test',
  ...extra,
});

/** Answers by endpoint path: `/410` → 410, `/net` → connection refused, anything else → 201. */
function fakePushService(): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const status = Number(new URL(url).pathname.slice(1));
    if (url.endsWith('/net')) {
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    }
    return Promise.resolve(new Response(null, { status: Number.isInteger(status) && status >= 200 ? status : 201 }));
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe('VapidWebPushSender', () => {
  let service: ReturnType<typeof fakePushService>;

  beforeEach(() => {
    integrationBreakers.reset();
    service = fakePushService();
  });

  afterEach(() => service.restore());

  it('is "not set up yet" without VAPID keys, and calls nobody', async () => {
    const sender = new VapidWebPushSender(config({ publicKey: '', privateKey: '' }));
    expect(() => sender.publicKey()).toThrow(IntegrationNotConfiguredException);
    await expect(sender.sendEach([delivery('https://fcm.googleapis.com/fcm/send/a')])).rejects.toBeInstanceOf(
      IntegrationNotConfiguredException,
    );
    expect(service.calls).toHaveLength(0);
  });

  it('serves the public key browsers subscribe with', () => {
    expect(new VapidWebPushSender(config()).publicKey()).toBe(vapid.publicKey);
  });

  it('accepts only https subscription URLs on a listed push service', () => {
    const sender = new VapidWebPushSender(config());
    expect(sender.acceptsEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(sender.acceptsEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(sender.acceptsEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(sender.acceptsEndpoint('https://FCM.googleapis.com:443/fcm/send/abc')).toBe(true);

    expect(sender.acceptsEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://fcm.googleapis.com.attacker.example/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://evilpush.apple.com.example/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://notpush.apple.com/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://fcm.googleapis.com:8443/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://user:pass@fcm.googleapis.com/abc')).toBe(false);
    expect(sender.acceptsEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(sender.acceptsEndpoint('not a url')).toBe(false);
  });

  it('sends an encrypted, VAPID-signed request per subscription, without following redirects', async () => {
    const sender = new VapidWebPushSender(config());
    const outcomes = await sender.sendEach([
      delivery('https://fcm.googleapis.com/fcm/send/a', { url: '/notes/1', data: { noteId: '1' } }),
    ]);
    expect(outcomes).toEqual([{ ok: true, errorCode: null, expired: false }]);
    const [{ url, init }] = service.calls;
    expect(url).toBe('https://fcm.googleapis.com/fcm/send/a');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'high' });
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${vapid.publicKey}$`));
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('content-length');
    // Encrypted: the title never travels in clear text.
    expect(Buffer.from(init.body as Uint8Array).toString('utf8')).not.toContain('Hello');
  });

  it('reports each outcome in input order; only 404 and 410 mean the subscription is gone', async () => {
    const sender = new VapidWebPushSender(config());
    const outcomes = await sender.sendEach([
      delivery('https://fcm.googleapis.com/201'),
      delivery('https://fcm.googleapis.com/410'),
      delivery('https://fcm.googleapis.com/404'),
      delivery('https://fcm.googleapis.com/403'),
      delivery('https://fcm.googleapis.com/429'),
      delivery('https://fcm.googleapis.com/net'),
    ]);
    expect(outcomes).toEqual([
      { ok: true, errorCode: null, expired: false },
      { ok: false, errorCode: 'http_410', expired: true },
      { ok: false, errorCode: 'http_404', expired: true },
      { ok: false, errorCode: 'http_403', expired: false },
      { ok: false, errorCode: 'http_429', expired: false },
      { ok: false, errorCode: 'ECONNREFUSED', expired: false },
    ]);
  });

  it('never calls a host off the list, and drops subscriptions it cannot encrypt for', async () => {
    const sender = new VapidWebPushSender(config());
    const outcomes = await sender.sendEach([
      delivery('https://attacker.example/hook'),
      {
        ...delivery('https://fcm.googleapis.com/a'),
        subscription: { endpoint: 'https://fcm.googleapis.com/a', keys: { p256dh: 'bad', auth: 'bad' } },
      },
      delivery('https://fcm.googleapis.com/b', { body: 'x'.repeat(5000) }),
    ]);
    expect(outcomes).toEqual([
      { ok: false, errorCode: 'host_not_allowed', expired: true },
      { ok: false, errorCode: 'invalid_subscription', expired: true },
      { ok: false, errorCode: 'payload_too_large', expired: false },
    ]);
    expect(service.calls).toHaveLength(0);
  });

  it(`keeps at most ${WEB_PUSH_CONCURRENCY} requests in flight`, async () => {
    service.restore();
    let inFlight = 0;
    let peak = 0;
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return new Response(null, { status: 201 });
    });
    try {
      const sender = new VapidWebPushSender(config());
      const many = Array.from({ length: WEB_PUSH_CONCURRENCY * 3 }, (_, i) =>
        delivery(`https://fcm.googleapis.com/fcm/send/${i}`),
      );
      const outcomes = await sender.sendEach(many);
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(peak).toBe(WEB_PUSH_CONCURRENCY);
    } finally {
      spy.mockRestore();
    }
  });
});
