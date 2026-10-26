import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { generateRequestDetails, type RequestDetails } from 'web-push';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { integrationsConfig, resilienceConfig } from '@/config/configuration';
import {
  classifyFailure,
  classifyHttpStatus,
  IntegrationCallException,
  redactSecrets,
} from '@/integrations/resilience/failure';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import {
  WEB_PUSH_CONCURRENCY,
  WEB_PUSH_MAX_PAYLOAD_BYTES,
  WebPushDelivery,
  WebPushOutcome,
  WebPushSender,
} from './web-push.port';

/**
 * Only these answers mean "this subscription is gone" (RFC 8030 §7.3). A 403 is NOT one: it also
 * comes from a VAPID misconfiguration (wrong key, clock skew), and pruning on it would wipe every
 * browser at once.
 */
export const EXPIRED_REASONS: ReadonlySet<string> = new Set(['http_404', 'http_410']);

const INTEGRATION = 'Web Push';

type WebPushConfig = Pick<ConfigType<typeof integrationsConfig>, 'webPush'>;

interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Browser push with VAPID. `web-push` encrypts the payload (aes128gcm) and signs the VAPID token;
 * the request itself goes out through `fetch` here so it gets the `webpush` circuit breaker, the
 * WEB_PUSH_TIMEOUT_MS deadline and the shared error classification. Subscription URLs come from
 * browsers, so only allowed push service hosts are ever called, and redirects are refused.
 */
@Injectable()
export class VapidWebPushSender extends WebPushSender {
  private readonly timeoutMs: number;

  constructor(
    @Inject(integrationsConfig.KEY) private readonly config: WebPushConfig,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).webpush;
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  acceptsEndpoint(endpoint: string): boolean {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return this.config.webPush.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  }

  async sendEach(deliveries: readonly WebPushDelivery[]): Promise<WebPushOutcome[]> {
    if (deliveries.length === 0) return [];
    const vapid = this.vapid();
    const outcomes = new Array<WebPushOutcome>(deliveries.length);
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < deliveries.length) {
        const index = next++;
        outcomes[index] = await this.deliver(deliveries[index], vapid);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WEB_PUSH_CONCURRENCY, deliveries.length) }, lane));
    return outcomes;
  }

  private async deliver(delivery: WebPushDelivery, vapid: VapidDetails): Promise<WebPushOutcome> {
    // Checked again at send time: the list may have shrunk since the browser registered.
    if (!this.acceptsEndpoint(delivery.subscription.endpoint)) {
      return { ok: false, errorCode: 'host_not_allowed', expired: true };
    }
    const payload = JSON.stringify({
      title: delivery.title,
      body: delivery.body,
      image: delivery.imageUrl || undefined,
      url: delivery.url,
      data: delivery.data,
    });
    if (Buffer.byteLength(payload) > WEB_PUSH_MAX_PAYLOAD_BYTES) {
      return { ok: false, errorCode: 'payload_too_large', expired: false };
    }
    let request: RequestDetails;
    try {
      request = generateRequestDetails(delivery.subscription, payload, {
        vapidDetails: vapid,
        TTL: this.config.webPush.ttlSeconds,
        contentEncoding: 'aes128gcm',
        urgency: 'high',
      });
    } catch {
      // Malformed browser keys: nothing can ever be encrypted for this subscription.
      return { ok: false, errorCode: 'invalid_subscription', expired: true };
    }
    try {
      await this.post(request);
      return { ok: true, errorCode: null, expired: false };
    } catch (error) {
      const { reason } = classifyFailure(error);
      return { ok: false, errorCode: reason, expired: EXPIRED_REASONS.has(reason) };
    }
  }

  /** One delivery request to the push service (tests override it). */
  protected post(request: RequestDetails): Promise<void> {
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name]) => name.toLowerCase() !== 'content-length')
        .map(([name, value]) => [name, String(value)]),
    );
    return guardedCall(
      INTEGRATION,
      async () => {
        const response = await fetch(request.endpoint, {
          method: 'POST',
          headers,
          body: request.body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new IntegrationCallException(
            INTEGRATION,
            classifyHttpStatus(response.status),
            new Error(`HTTP ${response.status}: ${redactSecrets(text)}`),
          );
        }
        await response.body?.cancel();
      },
      { deadlineMs: this.timeoutMs },
    );
  }

  private vapid(): VapidDetails {
    const { publicKey, privateKey, subject } = this.config.webPush;
    if (!publicKey || !privateKey) throw new IntegrationNotConfiguredException(INTEGRATION);
    return { subject, publicKey, privateKey };
  }
}
