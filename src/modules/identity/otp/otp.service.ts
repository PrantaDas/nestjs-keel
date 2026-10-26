import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import { authConfig, integrationsConfig, otpConfig, redisConfig } from '@/config/configuration';
import { QueueName } from '@/infra/queue/queue.constants';
import { REDIS_CORE } from '@/infra/redis/redis.constants';
import { IdentityErrors, IdentityException } from '../identity.errors';
import type { OtpChannel, OtpDeliveryJob, OtpTarget } from './otp.types';

const HOUR_MS = 3_600_000;

/*
 * Reserve one attempt atomically. KEYS: code hash. ARGV: none.
 * Returns nil when there is no live code, else { codeHash, attempts (after this one), expiresAtMs }.
 */
const RESERVE_ATTEMPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local attempts = redis.call('HINCRBY', KEYS[1], 'a', 1)
return { redis.call('HGET', KEYS[1], 'h'), attempts, redis.call('HGET', KEYS[1], 'e') }
`;

/* Single use: delete only if the stored hash is still the one that matched. KEYS: code. ARGV: hash. */
const CONSUME = `
if redis.call('HGET', KEYS[1], 'h') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * One-time codes for sign-in, e-mail verification, password reset and contact changes.
 *
 * - Codes come from `crypto.randomInt` and are stored only as an HMAC (key derived from the access
 *   secret), with an expiry; a new code replaces the previous one; a correct code is deleted
 *   atomically (single use) and compared in constant time.
 * - Limits: attempts per code, a resend cool-down, sends and verifications per recipient per hour.
 *   They fail closed (Redis down = 503), unlike the HTTP throttler, because they guard the SMS bill
 *   and brute force.
 * - No account discovery: the caller says whether to deliver. For an unknown recipient the same
 *   limits apply and an undeliverable code is stored, so every answer and error is identical.
 * - Delivery goes through the `otp-delivery` queue (SMS / mail ports, worker), so the response time
 *   does not depend on whether anything was sent. With `OTP_DEV_LOG` (never in production) the code
 *   is logged instead, so local sign-in works without a phone.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly hmacKey: Buffer;

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly redisSettings: ConfigType<typeof redisConfig>,
    @Inject(otpConfig.KEY) private readonly config: ConfigType<typeof otpConfig>,
    @Inject(integrationsConfig.KEY) private readonly integrations: ConfigType<typeof integrationsConfig>,
    @Inject(authConfig.KEY) auth: ConfigType<typeof authConfig>,
    @InjectQueue(QueueName.OTP_DELIVERY) private readonly deliveries: Queue<OtpDeliveryJob>,
    private readonly time: TimeService,
  ) {
    // A dedicated key derived from the access secret: one less secret to manage, never the secret itself.
    this.hmacKey = Buffer.from(hkdfSync('sha256', auth.accessSecret, 'otp-hmac', 'otp-v1', 32));
  }

  /**
   * Issues a code for `target`. `deliver: false` (no such account, or it may not be contacted) runs
   * exactly the same checks and stores a code nobody receives, so the outcome cannot reveal it.
   */
  async request(target: OtpTarget, { deliver }: { deliver: boolean }): Promise<void> {
    this.assertChannelAvailable(target.channel);
    const recipientKey = this.digest(`${target.channel}:${target.recipient}`);

    // Cool-down per purpose and recipient, counted before the hourly budget so a fast resend costs nothing.
    const cooldownMs = this.config.resendCooldownSeconds * 1000;
    if (cooldownMs > 0) {
      const fresh = await this.redis.set(
        this.key(`otp-cooldown:${target.purpose}:${recipientKey}`),
        '1',
        'PX',
        cooldownMs,
        'NX',
      );
      if (fresh !== 'OK') throw new IdentityException(IdentityErrors.OTP_RESEND_TOO_SOON);
    }
    const sends = await this.count(`otp-sends:${recipientKey}`);
    if (sends > this.config.maxSendsPerHour) throw new IdentityException(IdentityErrors.OTP_SEND_LIMIT);

    const code = this.generateCode();
    const ttlMs = this.config.ttlSeconds * 1000;
    const key = this.codeKey(target);
    await this.redis
      .multi()
      .del(key)
      .hset(key, { h: this.hashCode(key, code), a: '0', e: String(this.time.now().getTime() + ttlMs) })
      .pexpire(key, ttlMs)
      .exec();

    if (!deliver) return;
    const job: OtpDeliveryJob = {
      channel: target.channel,
      recipient: target.recipient,
      code,
      purpose: target.purpose,
      expiresInMinutes: Math.ceil(this.config.ttlSeconds / 60),
    };
    if (this.config.devLog) {
      this.logger.warn(
        { purpose: target.purpose, to: maskRecipient(target.recipient), code },
        'OTP_DEV_LOG: code not sent',
      );
      return;
    }
    // Deterministic id: the same send can never be enqueued twice; the processor claims it once.
    await this.deliveries.add('deliver', job, { jobId: `otp-${key.slice(-16)}-${sends}`, removeOnComplete: true });
  }

  /** Checks a code; throws OTP_INVALID / OTP_TOO_MANY_ATTEMPTS. A correct code works exactly once. */
  async verify(target: OtpTarget, code: string): Promise<void> {
    const recipientKey = this.digest(`${target.channel}:${target.recipient}`);
    const verifies = await this.count(`otp-verifies:${recipientKey}`);
    if (verifies > this.config.maxVerifiesPerHour) throw new IdentityException(IdentityErrors.OTP_TOO_MANY_ATTEMPTS);

    const key = this.codeKey(target);
    const reserved = (await this.redis.eval(RESERVE_ATTEMPT, 1, key)) as [string, number, string] | null;
    if (!reserved) throw new IdentityException(IdentityErrors.OTP_INVALID);
    const [storedHash, attempts, expiresAtMs] = reserved;

    if (this.time.now().getTime() >= Number(expiresAtMs)) {
      await this.redis.del(key);
      throw new IdentityException(IdentityErrors.OTP_INVALID);
    }
    if (attempts > this.config.maxAttempts) {
      await this.redis.del(key);
      throw new IdentityException(IdentityErrors.OTP_TOO_MANY_ATTEMPTS);
    }
    const presented = this.hashCode(key, code);
    if (!sameHex(presented, storedHash)) {
      if (attempts >= this.config.maxAttempts) await this.redis.del(key);
      throw new IdentityException(IdentityErrors.OTP_INVALID);
    }
    // Two requests racing with the right code: only the one that deletes it wins.
    if ((await this.redis.eval(CONSUME, 1, key, storedHash)) !== 1) {
      throw new IdentityException(IdentityErrors.OTP_INVALID);
    }
  }

  /** The text people receive (SMS body or e-mail line). */
  static message(appName: string, job: Pick<OtpDeliveryJob, 'code' | 'expiresInMinutes'>): string {
    return `Your ${appName} code is ${job.code}. It expires in ${job.expiresInMinutes} minutes. If you didn't ask for it, you can ignore this message.`;
  }

  private assertChannelAvailable(channel: OtpChannel): void {
    if (this.config.devLog) return;
    const { smtp, twilio } = this.integrations;
    if (channel === 'sms' && !(twilio.accountSid && twilio.authToken && twilio.from)) {
      throw new IntegrationNotConfiguredException('Twilio SMS');
    }
    if (channel === 'email' && !smtp.host) throw new IntegrationNotConfiguredException('SMTP');
  }

  private generateCode(): string {
    return String(randomInt(0, 10 ** this.config.length)).padStart(this.config.length, '0');
  }

  /** The stored form of a code: HMAC over the code and its key, so equal codes never hash alike. */
  private hashCode(key: string, code: string): string {
    return createHmac('sha256', this.hmacKey).update(`${key}:${code}`).digest('hex');
  }

  private digest(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex').slice(0, 32);
  }

  private codeKey(target: OtpTarget): string {
    return this.key(
      `otp:${this.digest(`${target.purpose}:${target.channel}:${target.recipient}:${target.subjectId ?? ''}`)}`,
    );
  }

  /** Hourly counter (fixed window from the first event). */
  private async count(name: string): Promise<number> {
    const key = this.key(name);
    const [[, value]] = (await this.redis.multi().incr(key).pexpire(key, HOUR_MS, 'NX').exec()) as [[unknown, number]];
    return value;
  }

  private key(name: string): string {
    return `${this.redisSettings.keyPrefix}${name}`;
  }
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** `ada@example.com` → `a***@example.com`, `+14155550123` → `+1*******123`: enough to debug, not to leak. */
export function maskRecipient(recipient: string): string {
  if (recipient.includes('@')) {
    const [name, domain] = recipient.split('@');
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return `${recipient.slice(0, 2)}${'*'.repeat(Math.max(0, recipient.length - 5))}${recipient.slice(-3)}`;
}
