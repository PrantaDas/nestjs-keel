import { generateKeyPairSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { deleteApp, getApps } from 'firebase-admin/app';
import type {
  BatchResponse,
  Message,
  Messaging,
  MessagingTopicManagementResponse,
  SendResponse,
} from 'firebase-admin/messaging';
import { IntegrationFailedException, IntegrationNotConfiguredException } from '@/common/exceptions';
import { FcmPushSender, FIREBASE_APP_NAME } from './fcm-push.sender';
import {
  PUSH_MAX_BATCH as FCM_MAX_BATCH,
  PUSH_MAX_TOPIC_BATCH as FCM_MAX_TOPIC_BATCH,
  type PushTokenMessage,
} from './push.port';

type Answer = SendResponse | 'throw';

/** Firebase Messaging at the boundary: answers each token as scripted (default: success). */
class FakeMessaging {
  readonly sendEachCalls: Message[][] = [];
  readonly answers = new Map<string, Answer>();
  failWholeCall: Error | null = null;
  shortResponse = false;

  sendEach(messages: Message[]): Promise<BatchResponse> {
    this.sendEachCalls.push(messages);
    if (this.failWholeCall) return Promise.reject(this.failWholeCall);
    const responses = messages.map((m) => this.answer((m as { token: string }).token));
    return Promise.resolve(this.batch(this.shortResponse ? responses.slice(1) : responses));
  }

  send(message: Message): Promise<string> {
    return Promise.resolve(`projects/test/messages/${(message as { topic: string }).topic}`);
  }

  readonly unsubscribeCalls: { tokens: string[]; topic: string }[] = [];
  unsubscribeErrors = new Map<string, string>();
  failUnsubscribe: Error | null = null;

  subscribeToTopic(tokens: string[], topic: string): Promise<MessagingTopicManagementResponse> {
    return this.unsubscribeFromTopic(tokens, topic);
  }

  unsubscribeFromTopic(tokens: string[], topic: string): Promise<MessagingTopicManagementResponse> {
    this.unsubscribeCalls.push({ tokens, topic });
    if (this.failUnsubscribe) return Promise.reject(this.failUnsubscribe);
    const errors = tokens.flatMap((token, index) => {
      const code = this.unsubscribeErrors.get(token);
      return code ? [{ index, error: Object.assign(new Error(code), { code }) }] : [];
    });
    return Promise.resolve({
      successCount: tokens.length - errors.length,
      failureCount: errors.length,
      errors,
    } as unknown as MessagingTopicManagementResponse);
  }

  private answer(token: string): SendResponse {
    const scripted = this.answers.get(token);
    if (scripted === 'throw') throw new Error('unexpected');
    return scripted ?? { success: true, messageId: `projects/test/messages/${token}` };
  }

  private batch(responses: SendResponse[]): BatchResponse {
    const successCount = responses.filter((r) => r.success).length;
    return { responses, successCount, failureCount: responses.length - successCount };
  }
}

const fcmError = (code: string): SendResponse =>
  ({ success: false, error: Object.assign(new Error(code), { code }) }) as unknown as SendResponse;

class TestPushService extends FcmPushSender {
  constructor(private readonly fake: FakeMessaging) {
    super({ firebase: { credentialsJson: '', credentialsFile: '' } });
  }

  protected override client(): Messaging {
    return this.fake as unknown as Messaging;
  }
}

const msg = (token: string, extra: Partial<PushTokenMessage> = {}): PushTokenMessage => ({
  token,
  title: 'Reminder',
  ...extra,
});

describe('FcmPushSender', () => {
  let fake: FakeMessaging;
  let push: TestPushService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    fake = new FakeMessaging();
    push = new TestPushService(fake);
  });

  describe('sendEach', () => {
    it('returns one outcome per message, in order: message id on success, error code otherwise', async () => {
      fake.answers.set('gone', fcmError('messaging/registration-token-not-registered'));
      fake.answers.set('malformed', fcmError('messaging/invalid-registration-token'));
      fake.answers.set('bad-payload', fcmError('messaging/invalid-argument'));
      fake.answers.set('busy', fcmError('messaging/server-unavailable'));
      fake.answers.set('silent', { success: false });

      const outcomes = await push.sendEach(
        ['ok', 'gone', 'malformed', 'bad-payload', 'busy', 'silent'].map((t) => msg(t)),
      );

      expect(outcomes).toEqual([
        { ok: true, messageId: 'projects/test/messages/ok', errorCode: null, invalidToken: false },
        { ok: false, messageId: null, errorCode: 'messaging/registration-token-not-registered', invalidToken: true },
        { ok: false, messageId: null, errorCode: 'messaging/invalid-registration-token', invalidToken: true },
        // A payload error (e.g. a bad image URL) never clears a working token.
        { ok: false, messageId: null, errorCode: 'messaging/invalid-argument', invalidToken: false },
        { ok: false, messageId: null, errorCode: 'messaging/server-unavailable', invalidToken: false },
        { ok: false, messageId: null, errorCode: 'messaging/unknown-error', invalidToken: false },
      ]);
    });

    it('sends each message with its own content and the platform options', async () => {
      await push.sendEach([
        msg('a', { body: 'Hello Ada', imageUrl: 'https://cdn.test/v.png', data: { screen: 'note' } }),
        msg('b', { title: 'Other', imageUrl: '' }),
      ]);
      expect(fake.sendEachCalls).toHaveLength(1);
      expect(fake.sendEachCalls[0]).toEqual([
        {
          token: 'a',
          notification: { title: 'Reminder', body: 'Hello Ada', imageUrl: 'https://cdn.test/v.png' },
          data: { screen: 'note' },
          android: { priority: 'high', notification: { sound: 'default' } },
          apns: { payload: { aps: { sound: 'default', mutableContent: true } } },
        },
        {
          token: 'b',
          notification: { title: 'Other', body: undefined, imageUrl: undefined },
          data: undefined,
          android: { priority: 'high', notification: { sound: 'default' } },
          apns: { payload: { aps: { sound: 'default', mutableContent: false } } },
        },
      ]);
    });

    it('takes at most 500 messages per call and makes no call for none', async () => {
      const full = Array.from({ length: FCM_MAX_BATCH }, (_, i) => msg(`t${i}`));
      expect(await push.sendEach(full)).toHaveLength(FCM_MAX_BATCH);
      await expect(push.sendEach([...full, msg('one-too-many')])).rejects.toBeInstanceOf(RangeError);
      expect(await push.sendEach([])).toEqual([]);
      expect(fake.sendEachCalls).toHaveLength(1);
    });

    it('a call that fails as a whole (or answers short) is an IntegrationFailedException', async () => {
      fake.failWholeCall = new Error('socket hang up');
      await expect(push.sendEach([msg('a')])).rejects.toBeInstanceOf(IntegrationFailedException);
      fake.failWholeCall = null;
      fake.shortResponse = true;
      await expect(push.sendEach([msg('a'), msg('b')])).rejects.toBeInstanceOf(IntegrationFailedException);
    });
  });

  describe('unsubscribeFromTopic', () => {
    it('dedupes, chunks by 1000 and reports refused tokens (dead ones marked invalid)', async () => {
      fake.unsubscribeErrors.set('t3', 'messaging/registration-token-not-registered');
      fake.unsubscribeErrors.set('t1000', 'messaging/internal-error');
      const tokens = [...Array.from({ length: FCM_MAX_TOPIC_BATCH + 1 }, (_, i) => `t${i}`), 't3', ''];

      const result = await push.unsubscribeFromTopic(tokens, 'app-all');

      expect(fake.unsubscribeCalls.map((c) => [c.tokens.length, c.topic])).toEqual([
        [1000, 'app-all'],
        [1, 'app-all'],
      ]);
      expect(result).toEqual({
        successCount: 999,
        failures: [
          { token: 't3', errorCode: 'messaging/registration-token-not-registered', invalidToken: true },
          { token: 't1000', errorCode: 'messaging/internal-error', invalidToken: false },
        ],
      });
      expect(await push.unsubscribeFromTopic([], 'app-all')).toEqual({ successCount: 0, failures: [] });
      expect(fake.unsubscribeCalls).toHaveLength(2);
    });

    it('a call that fails as a whole is an IntegrationFailedException', async () => {
      fake.failUnsubscribe = new Error('socket hang up');
      await expect(push.unsubscribeFromTopic(['a'], 'app-all')).rejects.toBeInstanceOf(IntegrationFailedException);
    });
  });

  it('without credentials: INTEGRATION_NOT_CONFIGURED (not a failed call)', async () => {
    const unconfigured = new FcmPushSender({ firebase: { credentialsJson: '', credentialsFile: '' } });
    await expect(unconfigured.sendEach([msg('a')])).rejects.toBeInstanceOf(IntegrationNotConfiguredException);
    await expect(unconfigured.sendToTopic('all', { title: 'x' })).rejects.toBeInstanceOf(
      IntegrationNotConfiguredException,
    );
  });

  describe('Firebase app', () => {
    afterEach(async () => {
      await Promise.all(getApps().map((app) => deleteApp(app)));
    });

    it('is created once per process, however many service instances (Nest contexts) use it', () => {
      // Throwaway key generated for the test: cert() only checks that it parses.
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const credentials = Buffer.from(
        JSON.stringify({
          project_id: 'app-test',
          client_email: 'push-test@app-test.iam.gserviceaccount.com',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      ).toString('base64');
      const clientOf = (service: FcmPushSender) => (service as unknown as { client(): Messaging }).client();

      const first = clientOf(new FcmPushSender({ firebase: { credentialsJson: credentials, credentialsFile: '' } }));
      const second = clientOf(new FcmPushSender({ firebase: { credentialsJson: credentials, credentialsFile: '' } }));

      expect(getApps().map((app) => app.name)).toEqual([FIREBASE_APP_NAME]);
      expect(second.app).toBe(first.app);
    });
  });
});
