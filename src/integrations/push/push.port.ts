export interface PushMessage {
  title: string;
  body?: string;
  imageUrl?: string;
  /** FCM data values must be strings. */
  data?: Record<string, string>;
}

/** One message to one device token (content may differ per token). */
export interface PushTokenMessage extends PushMessage {
  token: string;
}

/** What the provider answered for one message of a `sendEach` call. */
export interface PushSendOutcome {
  ok: boolean;
  messageId: string | null;
  /** Provider error code (`messaging/...`) when not ok. */
  errorCode: string | null;
  /** The token will never work again (unregistered / malformed): delete it. */
  invalidToken: boolean;
}

export interface TopicMembershipResult {
  successCount: number;
  /** Tokens the provider refused. A dead token (`invalidToken`) should be deleted. */
  failures: { token: string; errorCode: string; invalidToken: boolean }[];
}

/** FCM accepts at most 500 messages per `sendEach` call. */
export const PUSH_MAX_BATCH = 500;
/** FCM topic management accepts at most 1000 tokens per call. */
export const PUSH_MAX_TOPIC_BATCH = 1000;

/**
 * Push notifications. Only the notifications module uses it (everything else goes through the
 * `Notifier` contract). FCM is bound in `IntegrationsModule`; tests bind a fake.
 */
export abstract class PushSender {
  /** One batch (≤ 500), one outcome per message in input order. Never retried by the implementation. */
  abstract sendEach(messages: readonly PushTokenMessage[]): Promise<PushSendOutcome[]>;
  abstract sendToTopic(topic: string, message: PushMessage): Promise<string>;
  abstract subscribeToTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult>;
  abstract unsubscribeFromTopic(tokens: readonly string[], topic: string): Promise<TopicMembershipResult>;
}
