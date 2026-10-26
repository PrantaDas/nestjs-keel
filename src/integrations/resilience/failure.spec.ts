import { IntegrationFailedException, IntegrationNotConfiguredException } from '@/common/exceptions';
import { DeadlineExceededError } from './deadline';
import {
  classifyFailure,
  classifyHttpStatus,
  IntegrationCallException,
  IntegrationOutcomeUnknownException,
  IntegrationUnavailableException,
  isPermanentIntegrationFailure,
  isTransientIntegrationFailure,
  redactSecrets,
  toIntegrationError,
} from './failure';

const withCode = (code: unknown, extra: object = {}) => Object.assign(new Error(String(code)), { code }, extra);

describe('classifyFailure', () => {
  it.each([
    // fetch / undici
    ['fetch timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), true, true],
    ['our deadline', new DeadlineExceededError(100), true, true],
    ['refused connection', new TypeError('fetch failed', { cause: withCode('ECONNREFUSED') }), true, false],
    ['DNS failure', new TypeError('fetch failed', { cause: withCode('ENOTFOUND') }), true, false],
    ['connect timeout', new TypeError('fetch failed', { cause: withCode('UND_ERR_CONNECT_TIMEOUT') }), true, false],
    ['reset mid-request', new TypeError('fetch failed', { cause: withCode('ECONNRESET') }), true, true],
    ['socket closed', new TypeError('fetch failed', { cause: withCode('UND_ERR_SOCKET') }), true, true],
    // HTTP statuses (Twilio RestException, AWS $metadata, …)
    ['429', { status: 429 }, true, false],
    ['503', { statusCode: 503 }, true, false],
    ['500', { status: 500 }, true, true],
    ['504', { $metadata: { httpStatusCode: 504 } }, true, true],
    ['400', { status: 400 }, false, false],
    ['401', { status: 401 }, false, false],
    ['404', { response: { status: 404 } }, false, false],
    // firebase-admin
    ['FCM unavailable', withCode('messaging/server-unavailable'), true, false],
    ['FCM internal', withCode('messaging/internal-error'), true, true],
    ['FCM quota', withCode('messaging/quota-exceeded'), true, false],
    ['FCM bad payload', withCode('messaging/invalid-argument'), false, false],
    ['FCM auth', withCode('messaging/third-party-auth-error'), false, false],
    ['firebase network timeout', withCode('app/network-timeout'), true, true],
    // gRPC (inter-service transport)
    ['gRPC unavailable', withCode(14), true, false],
    ['gRPC deadline', withCode(4), true, true],
    ['gRPC invalid argument', withCode(3), false, false],
    ['gRPC unauthenticated', withCode(16), false, false],
    // nodemailer
    ['SMTP 421', Object.assign(new Error('try later'), { responseCode: 421, code: 'EENVELOPE' }), true, false],
    ['SMTP 550', Object.assign(new Error('no such user'), { responseCode: 550 }), false, false],
    ['SMTP auth', withCode('EAUTH'), false, false],
    ['SMTP connect', withCode('ECONNECTION'), true, false],
    ['SMTP socket', withCode('ESOCKET'), true, true],
    // AWS SDK
    ['AWS throttling', Object.assign(new Error('slow'), { name: 'ThrottlingException' }), true, true],
    ['AWS retryable', Object.assign(new Error('x'), { $retryable: {} }), true, true],
    ['AWS client fault', Object.assign(new Error('x'), { name: 'NoSuchBucket', $fault: 'client' }), false, false],
    // unknown
    ['plain error', new Error('boom'), true, true],
    ['non-error', 'boom', true, true],
  ])('%s → transient %s, ambiguous %s', (_label, error, transient, ambiguous) => {
    expect(classifyFailure(error)).toMatchObject({ transient, ambiguous });
  });

  it('reads our own exceptions as they were classified', () => {
    const call = new IntegrationCallException('SMTP', { transient: false, ambiguous: false, reason: 'smtp_550' });
    expect(classifyFailure(call)).toEqual({ transient: false, ambiguous: false, reason: 'smtp_550' });
    expect(classifyFailure(new IntegrationUnavailableException('SMTP', 5))).toMatchObject({
      transient: true,
      ambiguous: false,
    });
    expect(classifyFailure(new IntegrationOutcomeUnknownException('SMTP'))).toMatchObject({
      transient: false,
      ambiguous: true,
    });
    expect(classifyFailure(new IntegrationNotConfiguredException('SMTP'))).toMatchObject({
      transient: false,
      reason: 'not_configured',
    });
  });

  it('classifies a bare IntegrationFailedException by its cause (no cause: transient, not ambiguous)', () => {
    expect(classifyFailure(new IntegrationFailedException('S3'))).toMatchObject({ transient: true, ambiguous: false });
    expect(classifyFailure(new IntegrationFailedException('S3', { status: 403 }))).toMatchObject({ transient: false });
    expect(classifyFailure(new IntegrationFailedException('S3', withCode('ECONNRESET')))).toMatchObject({
      transient: true,
      ambiguous: true,
    });
  });
});

describe('classifyHttpStatus', () => {
  it('treats 408/429/502/503 as never acted on, 500/504 as maybe acted on, 4xx as permanent', () => {
    expect([408, 429, 502, 503].map((s) => classifyHttpStatus(s).ambiguous)).toEqual([false, false, false, false]);
    expect([500, 504].map((s) => classifyHttpStatus(s))).toEqual([
      { transient: true, ambiguous: true, reason: 'http_500' },
      { transient: true, ambiguous: true, reason: 'http_504' },
    ]);
    expect([400, 403, 422, 501].every((s) => !classifyHttpStatus(s).transient)).toBe(true);
  });
});

describe('integration error helpers', () => {
  it('wraps SDK errors once and passes domain errors through', () => {
    const wrapped = toIntegrationError('AWS S3', withCode('ECONNREFUSED'));
    expect(wrapped).toBeInstanceOf(IntegrationCallException);
    expect(wrapped).toBeInstanceOf(IntegrationFailedException);
    expect(wrapped).toMatchObject({ transient: true, ambiguous: false, retryable: true, error: 'INTEGRATION_FAILED' });
    expect(toIntegrationError('AWS S3', wrapped)).toBe(wrapped);
    const notConfigured = new IntegrationNotConfiguredException('AWS S3');
    expect(toIntegrationError('AWS S3', notConfigured)).toBe(notConfigured);
  });

  it('tells transient from permanent integration failures (other errors are neither)', () => {
    const t = new IntegrationCallException('x', { transient: true, ambiguous: false, reason: 'http_503' });
    const p = new IntegrationCallException('x', { transient: false, ambiguous: false, reason: 'http_400' });
    expect([t, p, new IntegrationUnavailableException('x', 1)].map(isTransientIntegrationFailure)).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      [p, new IntegrationNotConfiguredException('x'), new IntegrationOutcomeUnknownException('x'), t].map(
        isPermanentIntegrationFailure,
      ),
    ).toEqual([true, true, true, false]);
    expect(isTransientIntegrationFailure(new Error('db'))).toBe(false);
    expect(isPermanentIntegrationFailure(new Error('db'))).toBe(false);
    expect(new IntegrationOutcomeUnknownException('x')).toMatchObject({ retryable: false, errorCode: 9151 });
  });
});

describe('redactSecrets', () => {
  it('removes tokens, keys and private keys, and caps the length', () => {
    expect(redactSecrets('authorization: Bearer abc.DEF-123')).toBe('authorization: Bearer ***');
    expect(redactSecrets('GET /v2/1.2.3.4?key=s3cr3t&asn=1')).toBe('GET /v2/1.2.3.4?key=***&asn=1');
    expect(redactSecrets('{"authkey":"xyz","token": "t0k"}')).toBe('{"authkey":"***","token": "***"}');
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----')).toBe('[private key]');
    expect(redactSecrets('x'.repeat(600))).toHaveLength(500);
  });
});
