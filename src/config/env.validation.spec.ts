import { envValidationSchema } from './env.validation';

const base = {
  MONGO_URI: 'mongodb://localhost:27047/app',
  REDIS_URL: 'redis://localhost:6389',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(env, { abortEarly: false, allowUnknown: true });

describe('environment validation', () => {
  it('fills safe defaults for everything optional', () => {
    const { value, error } = validate(base);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      API_PORT: 3000,
      BUSINESS_TIMEZONE: 'UTC',
      REDIS_CACHE_URL: '',
      STRIPE_SECRET_KEY: '',
    });
  });

  it('lists every problem at once, readably', () => {
    const { error } = validate({ ...base, MONGO_URI: '', JWT_ACCESS_SECRET: 'short', API_PORT: 'eighty' });
    const messages = error!.details.map((d) => d.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        '"MONGO_URI" is not allowed to be empty',
        '"JWT_ACCESS_SECRET" length must be at least 32 characters long',
        '"API_PORT" must be a number',
      ]),
    );
  });

  it('binds every listener to an IP address, all interfaces by default', () => {
    expect(validate(base).value.LISTEN_HOST).toBe('0.0.0.0');
    expect(validate({ ...base, LISTEN_HOST: '127.0.0.1' }).error).toBeUndefined();
    expect(validate({ ...base, LISTEN_HOST: 'my-host' }).error?.message).toMatch(/LISTEN_HOST/);
  });

  it('takes browser push keys as a pair, and only push services from the list', () => {
    const publicKey = 'B'.repeat(87);
    const privateKey = 'p'.repeat(43);
    expect(validate(base).value).toMatchObject({ WEB_PUSH_VAPID_PUBLIC_KEY: '', WEB_PUSH_VAPID_PRIVATE_KEY: '' });
    expect(
      validate({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: privateKey }).error,
    ).toBeUndefined();
    expect(validate({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: publicKey }).error?.message).toMatch(/are set together/);
    expect(validate({ ...base, WEB_PUSH_VAPID_PRIVATE_KEY: privateKey }).error?.message).toMatch(/are set together/);
    expect(
      validate({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: 'short', WEB_PUSH_VAPID_PRIVATE_KEY: privateKey }).error?.message,
    ).toMatch(/base64url VAPID public key/);
    expect(validate({ ...base, WEB_PUSH_SUBJECT: 'admin@example.com' }).error?.message).toMatch(/WEB_PUSH_SUBJECT/);
    expect(validate({ ...base, WEB_PUSH_SUBJECT: 'https://example.com/contact' }).error).toBeUndefined();
  });

  it('rejects offset-style business time zones', () => {
    const { error } = validate({ ...base, BUSINESS_TIMEZONE: '+04:00' });
    expect(error?.message).toMatch(/IANA time zone name/);
    expect(validate({ ...base, BUSINESS_TIMEZONE: 'Asia/Dubai' }).error).toBeUndefined();
  });

  it('refuses development conveniences and placeholder secrets in production', () => {
    const production = { ...base, NODE_ENV: 'production' };
    expect(validate({ ...production, OTP_DEV_LOG: 'true' }).error?.message).toMatch(
      /OTP_DEV_LOG" must be false in production/,
    );
    expect(
      validate({ ...production, JWT_ACCESS_SECRET: 'local-access-secret-change-me-0123456789abcdef' }).error?.message,
    ).toMatch(/still the local placeholder/);
    expect(validate({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET }).error?.message).toMatch(/must differ/);
    expect(validate(production).error).toBeUndefined();
  });
});
