import { Types } from 'mongoose';
import { isSensitiveKey, keyWords, sanitizeForLog } from './sanitize';

describe('sanitizeForLog', () => {
  it('redacts secrets at any depth', () => {
    expect(
      sanitizeForLog({ phone: '+91', otp: '123456', nested: { password: 'p', refreshToken: 't', name: 'n' } }),
    ).toEqual({
      phone: '+91',
      otp: '[redacted]',
      nested: { password: '[redacted]', refreshToken: '[redacted]', name: 'n' },
    });
  });

  it('redacts integration credentials (auth keys, API keys, tokens, passwords)', () => {
    expect(
      sanitizeForLog({
        smtp: { host: 'smtp.test', user: 'mailer', pass: 'p' },
        twilio: { accountSid: 'AC1', authToken: 't' },
        msg91: { authKey: 'k', widgetId: 'w', baseUrl: 'https://msg91.test' },
        wati: { token: 't' },
        headers: { 'x-api-key': 'k', authkey: 'k', Authorization: 'Bearer x' },
        apiKey: 'k',
        api_key: 'k',
        APIKey: 'k',
        privateKey: 'k',
        SETTINGS_ENCRYPTION_KEY: 'k',
      }),
    ).toEqual({
      smtp: { host: 'smtp.test', user: 'mailer', pass: '[redacted]' },
      twilio: { accountSid: 'AC1', authToken: '[redacted]' },
      msg91: { authKey: '[redacted]', widgetId: 'w', baseUrl: 'https://msg91.test' },
      wati: { token: '[redacted]' },
      headers: { 'x-api-key': '[redacted]', authkey: '[redacted]', Authorization: '[redacted]' },
      apiKey: '[redacted]',
      api_key: '[redacted]',
      APIKey: '[redacted]',
      privateKey: '[redacted]',
      SETTINGS_ENCRYPTION_KEY: '[redacted]',
    });
  });

  it('does not redact fields that merely contain a secret word', () => {
    const readable = {
      appInReview: true,
      passage: 'John 3:16',
      spinner: 1,
      opinion: 'x',
      compass: 'n',
      bypassCache: false,
      imageKey: 'avatars/a.png',
      idempotencyKey: 'abc-123',
      key: 'files/x.pdf',
      tokenizerVersion: 2,
    };
    expect(sanitizeForLog(readable)).toEqual(readable);
  });

  it('keeps cleared (null) secrets visible: they carry no secret', () => {
    expect(sanitizeForLog({ msg91: { authKey: null }, smtp: { pass: undefined } })).toEqual({
      msg91: { authKey: null },
      smtp: { pass: undefined },
    });
  });

  it('truncates long strings and big arrays', () => {
    const result = sanitizeForLog({ text: 'x'.repeat(3000), list: Array.from({ length: 60 }, (_, i) => i) }) as {
      text: string;
      list: unknown[];
    };
    expect(result.text.endsWith('[truncated]')).toBe(true);
    expect(result.list).toHaveLength(51);
    expect(result.list.at(-1)).toBe('…[10 more]');
  });

  it('stringifies ObjectIds and keeps dates', () => {
    const id = new Types.ObjectId();
    const at = new Date();
    expect(sanitizeForLog({ id, at })).toEqual({ id: id.toHexString(), at });
  });
});

describe('isSensitiveKey', () => {
  it('splits camelCase, PascalCase, snake_case and kebab-case keys into words', () => {
    expect(keyWords('appInReview')).toEqual(['app', 'in', 'review']);
    expect(keyWords('APIKey')).toEqual(['api', 'key']);
    expect(keyWords('x-api-key')).toEqual(['x', 'api', 'key']);
    expect(keyWords('refresh_token')).toEqual(['refresh', 'token']);
    expect(keyWords('smtp.pass')).toEqual(['smtp', 'pass']);
  });

  it.each(['password', 'newPassword', 'currentPassword', 'otpCode', 'pinCode', 'cvv', 'clientSecret', 'cookies'])(
    'flags %s',
    (key) => expect(isSensitiveKey(key)).toBe(true),
  );

  it.each(['appInReview', 'pinned', 'passage', 'keyPrefix', 'monkey', 'apiVersion', 'authorName', 'phone'])(
    'leaves %s alone',
    (key) => expect(isSensitiveKey(key)).toBe(false),
  );
});
