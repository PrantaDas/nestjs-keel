import { readFileSync } from 'node:fs';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import {
  getMessaging,
  type Message,
  type Messaging,
  type MessagingTopicManagementResponse,
  type SendResponse,
} from 'firebase-admin/messaging';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { integrationsConfig, resilienceConfig } from '@/config/configuration';
import { IntegrationCallException } from '@/integrations/resilience/failure';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import {
  PUSH_MAX_BATCH,
  PUSH_MAX_TOPIC_BATCH,
  PushMessage,
  PushSender,
  PushSendOutcome,
  PushTokenMessage,
  TopicMembershipResult,
} from './push.port';

/**
 * Only these codes mean "this token is dead". `messaging/invalid-argument` is NOT one: FCM reports a
 * bad payload (image URL, data key, size) with it, and treating it as a dead token would wipe
 * working devices.
 */
export const INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Name of the one Firebase app of the process. */
export const FIREBASE_APP_NAME = 'app-push';

const INTEGRATION = 'Firebase Cloud Messaging';

type FirebaseConfig = Pick<ConfigType<typeof integrationsConfig>, 'firebase'>;

/**
 * Service-account credentials from the environment: the JSON itself (raw or base64) or a file path.
 * Never logged; a key file must never be committed (.gitignore covers `*-service-account*.json`).
 */
export function firebaseCredentials({ firebase }: FirebaseConfig): ServiceAccount | undefined {
  const raw = firebase.credentialsJson.trim();
  if (raw) {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json) as ServiceAccount;
  }
  if (firebase.credentialsFile) return JSON.parse(readFileSync(firebase.credentialsFile, 'utf8')) as ServiceAccount;
  return undefined;
}

/**
 * Firebase Cloud Messaging through the Admin SDK, one app per process, created on first use. Every
 * call goes through the `fcm` circuit breaker and releases the caller after FCM_TIMEOUT_MS
 * (firebase-admin retries 503 / ECONNRESET internally). Sends are never retried here: the
 * notifications module claims deliveries and never re-sends.
 */
@Injectable()
export class FcmPushSender extends PushSender {
  private messaging?: Messaging;
  private readonly timeoutMs: number;

  constructor(
    @Inject(integrationsConfig.KEY) private readonly config: FirebaseConfig,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).fcm;
  }

  async sendEach(messages: readonly PushTokenMessage[]): Promise<PushSendOutcome[]> {
    if (messages.length === 0) return [];
    if (messages.length > PUSH_MAX_BATCH) {
      throw new RangeError(`sendEach accepts at most ${PUSH_MAX_BATCH} messages, got ${messages.length}`);
    }
    const client = this.client();
    const { responses } = await this.guard(() =>
      client.sendEach(messages.map((m) => ({ token: m.token, ...this.payload(m) }))),
    );
    if (responses.length !== messages.length) {
      throw new IntegrationCallException(
        INTEGRATION,
        { transient: true, ambiguous: true, reason: 'short_response' },
        new Error(`FCM returned ${responses.length} responses for ${messages.length} messages`),
      );
    }
    return responses.map(toOutcome);
  }

  async sendToTopic(topic: string, message: PushMessage): Promise<string> {
    const client = this.client();
    return this.guard(() => client.send({ topic, ...this.payload(message) }));
  }

  subscribeToTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult> {
    return this.manageTopic(tokens, topic, (client, batch) => client.subscribeToTopic(batch, topic));
  }

  unsubscribeFromTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult> {
    return this.manageTopic(tokens, topic, (client, batch) => client.unsubscribeFromTopic(batch, topic));
  }

  /** Chunks by 1000; per-token refusals are reported, never thrown. */
  private async manageTopic(
    tokens: readonly string[],
    _topic: string,
    call: (client: Messaging, batch: string[]) => Promise<MessagingTopicManagementResponse>,
  ): Promise<TopicMembershipResult> {
    const result: TopicMembershipResult = { successCount: 0, failures: [] };
    const unique = [...new Set(tokens)].filter(Boolean);
    for (let i = 0; i < unique.length; i += PUSH_MAX_TOPIC_BATCH) {
      const batch = unique.slice(i, i + PUSH_MAX_TOPIC_BATCH);
      const client = this.client();
      const response = await this.guard(() => call(client, batch));
      result.successCount += response.successCount;
      for (const { index, error } of response.errors) {
        const errorCode = error?.code ?? 'messaging/unknown-error';
        result.failures.push({ token: batch[index], errorCode, invalidToken: INVALID_TOKEN_CODES.has(errorCode) });
      }
    }
    return result;
  }

  private guard<T>(call: () => Promise<T>): Promise<T> {
    return guardedCall(INTEGRATION, call, { deadlineMs: this.timeoutMs });
  }

  private payload(message: PushMessage): Omit<Message, 'token' | 'topic' | 'condition'> {
    return {
      notification: { title: message.title, body: message.body, imageUrl: message.imageUrl || undefined },
      data: message.data,
      android: { priority: 'high', notification: { sound: 'default' } },
      apns: { payload: { aps: { sound: 'default', mutableContent: Boolean(message.imageUrl) } } },
    };
  }

  /** The Messaging client of the process's Firebase app (tests override it with a fake). */
  protected client(): Messaging {
    if (this.messaging) return this.messaging;
    const credentials = firebaseCredentials(this.config);
    if (!credentials) throw new IntegrationNotConfiguredException(INTEGRATION);
    // Reuse the app when another instance of this class (another Nest context) created it.
    const app =
      getApps().find((a) => a.name === FIREBASE_APP_NAME) ??
      initializeApp({ credential: cert(credentials) }, FIREBASE_APP_NAME);
    this.messaging = getMessaging(app);
    return this.messaging;
  }
}

function toOutcome(response: SendResponse): PushSendOutcome {
  if (response.success) {
    return { ok: true, messageId: response.messageId ?? null, errorCode: null, invalidToken: false };
  }
  const errorCode = response.error?.code ?? 'messaging/unknown-error';
  return { ok: false, messageId: null, errorCode, invalidToken: INVALID_TOKEN_CODES.has(errorCode) };
}
