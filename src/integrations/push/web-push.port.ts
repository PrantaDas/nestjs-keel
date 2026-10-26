import type { PushMessage } from './push.port';

/** What a browser's `PushSubscription.toJSON()` holds: where to deliver, and the keys to encrypt for. */
export interface WebPushSubscription {
  endpoint: string;
  keys: {
    /** The browser's P-256 public key (base64url). */
    p256dh: string;
    /** The browser's auth secret (base64url). */
    auth: string;
  };
}

/** One message to one browser subscription (content may differ per subscription). */
export interface WebPushDelivery extends PushMessage {
  subscription: WebPushSubscription;
  /** Page the service worker opens when the notification is clicked. */
  url?: string;
}

/** What the push service answered for one delivery of a `sendEach` call. */
export interface WebPushOutcome {
  ok: boolean;
  /** `http_<status>`, `timeout`, `circuit_open`, `payload_too_large`, … when not ok. */
  errorCode: string | null;
  /** The subscription will never work again (404 / 410, or refused host): delete it. */
  expired: boolean;
}

/** Deliveries sent at once; each is its own HTTPS request to a push service. */
export const WEB_PUSH_CONCURRENCY = 16;

/** Push services accept 4096 bytes of encrypted record; this leaves room for the aes128gcm framing. */
export const WEB_PUSH_MAX_PAYLOAD_BYTES = 3800;

/**
 * Browser push (W3C Push API, RFC 8030 with VAPID, RFC 8292). Only the notifications module uses it,
 * like `PushSender`; everything else goes through the `Notifier` contract. Bound in
 * `IntegrationsModule`; tests bind a fake.
 */
export abstract class WebPushSender {
  /**
   * The VAPID public key browsers pass to `pushManager.subscribe({ applicationServerKey })`.
   * Throws INTEGRATION_NOT_CONFIGURED when browser push is off.
   */
  abstract publicKey(): string;

  /** True when a subscription URL points at an allowed push service (https, listed host). */
  abstract acceptsEndpoint(endpoint: string): boolean;

  /**
   * One outcome per delivery in input order. Per-delivery failures are reported, never thrown; only
   * INTEGRATION_NOT_CONFIGURED is. Never retried by the implementation.
   */
  abstract sendEach(deliveries: readonly WebPushDelivery[]): Promise<WebPushOutcome[]>;
}
