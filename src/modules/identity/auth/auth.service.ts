import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { AuthUser, TokenPair } from '@/common/auth/auth.types';
import { DeviceRegistry } from '@/common/contracts/device-registry.contract';
import { UserRegistered } from '@/common/contracts/identity.events';
import { RequestContext } from '@/common/context/request-context';
import { TimeService } from '@/common/time/time.service';
import { authConfig } from '@/config/configuration';
import { TransactionService } from '@/infra/database/transaction.service';
import { OutboxService } from '@/infra/events/outbox.service';
import { IdentityErrors, IdentityException } from '../identity.errors';
import { OtpService } from '../otp/otp.service';
import type { OtpChannel } from '../otp/otp.types';
import { SessionService } from '../sessions/session.service';
import { canSignIn, isReachable } from '../users/account-rules';
import { decoyHash, needsRehash, verifyPassword } from '../users/password';
import { UserDoc, UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import type { UserView } from '../users/users.views';
import type { DeviceDto, LoginDto, RegisterDto } from './dto/auth.dto';

export interface AuthResult extends TokenPair {
  user: UserView;
}

export interface Contact {
  channel: OtpChannel;
  recipient: string;
}

/**
 * Sign-up, sign-in (password or one-time code), refresh, sign-out, password reset, e-mail
 * verification and contact changes. Every successful sign-in path ends in `signIn()`, which issues
 * the same token pair, reactivates a self-deactivated account and registers the device for push.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly repository: UsersRepository,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
    private readonly transactions: TransactionService,
    private readonly outbox: OutboxService,
    private readonly time: TimeService,
    @Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>,
    @Optional() private readonly devices?: DeviceRegistry,
  ) {}

  // ── Sign-up and password sign-in ────────────────────────────────────────

  async register(dto: RegisterDto): Promise<AuthResult> {
    if (await this.repository.findByEmail(dto.email)) throw new IdentityException(IdentityErrors.EMAIL_TAKEN);
    // A race between two sign-ups with one e-mail ends in the unique index: mapped to EMAIL_TAKEN.
    const user = await this.transactions.run(async (session) => {
      const created = await this.users.create({ name: dto.name, email: dto.email, password: dto.password }, session);
      await this.outbox.add(
        UserRegistered({ userId: created._id.toHexString(), email: created.email }, this.time.now()),
        session,
      );
      return created;
    });
    // Confirmation code for the address; a failure here must not fail the sign-up.
    await this.otp
      .request(
        { purpose: 'verify-email', channel: 'email', recipient: dto.email, subjectId: user._id.toHexString() },
        { deliver: true },
      )
      .catch((err: unknown) => this.logger.warn({ err, userId: user._id }, 'Verification code not sent at sign-up'));
    return this.signIn(user, dto.device);
  }

  /**
   * Password sign-in. Unknown e-mail and wrong password give the same error after the same work
   * (a decoy hash is checked), so the answer never tells whether an account exists. Repeated
   * failures lock the account for AUTH_LOCKOUT_SECONDS.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const account = await this.repository.findByEmailWithPassword(dto.email);
    if (!account || !account.passwordHash) {
      await verifyPassword(dto.password, await decoyHash());
      throw new IdentityException(IdentityErrors.INVALID_CREDENTIALS);
    }
    const now = this.time.now();
    if (account.lockedUntil && account.lockedUntil > now) throw new IdentityException(IdentityErrors.ACCOUNT_LOCKED);
    if (!(await verifyPassword(dto.password, account.passwordHash))) {
      const lockUntil = this.time.after(this.config.lockoutSeconds * 1000, now);
      const updated = await this.repository.recordFailedLogin(account._id, this.config.maxFailedLogins, lockUntil);
      if (updated?.lockedUntil && updated.lockedUntil > now) throw new IdentityException(IdentityErrors.ACCOUNT_LOCKED);
      throw new IdentityException(IdentityErrors.INVALID_CREDENTIALS);
    }
    if (!canSignIn(account)) throw new IdentityException(IdentityErrors.ACCOUNT_DEACTIVATED);
    if (needsRehash(account.passwordHash)) await this.users.setPassword(account._id.toHexString(), dto.password);
    return this.signIn(account, dto.device);
  }

  // ── One-time code sign-in ───────────────────────────────────────────────

  /**
   * Sends a sign-in code to a phone or e-mail address. Always answers the same way: when no
   * account may sign in with it, nothing is delivered but the same limits apply.
   */
  async requestLoginCode(contact: Contact): Promise<void> {
    const account = await this.findByContact(contact);
    const deliver = Boolean(account && canSignIn(account) && account.status !== 'deleted');
    await this.otp.request({ purpose: 'login', ...contact }, { deliver });
  }

  async verifyLoginCode(contact: Contact, code: string, device?: DeviceDto): Promise<AuthResult> {
    await this.otp.verify({ purpose: 'login', ...contact }, code);
    const account = await this.findByContact(contact);
    // A code can only have been delivered to an existing account; anything else reads as a wrong code.
    if (!account || !canSignIn(account)) throw new IdentityException(IdentityErrors.OTP_INVALID);
    // Receiving the code proves the address: mark it verified.
    const field = contact.channel === 'sms' ? 'phoneVerifiedAt' : 'emailVerifiedAt';
    if (!account[field]) await this.repository.updateById(account._id, { $set: { [field]: this.time.now() } });
    return this.signIn(account, device);
  }

  // ── Tokens and sessions ─────────────────────────────────────────────────

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.sessions.refresh(refreshToken, async (userId) => {
      const user = await this.repository.findById(userId);
      return Boolean(
        user && user.status !== 'deleted' && !(user.status === 'deactivated' && user.deactivatedBy === 'admin'),
      );
    });
  }

  async logout(user: AuthUser): Promise<number> {
    return (await this.sessions.revoke(user.id, user.sessionId)) ? 1 : 0;
  }

  logoutEverywhere(user: AuthUser): Promise<number> {
    return this.sessions.revokeAll(user.id);
  }

  async listSessions(user: AuthUser) {
    const sessions = await this.sessions.list(user.id);
    return sessions.map((s) => ({
      _id: s.id,
      device: s.device,
      ip: s.ip,
      current: s.id === user.sessionId,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeSession(user: AuthUser, sessionId: string): Promise<void> {
    if (!(await this.sessions.revoke(user.id, sessionId))) {
      throw new IdentityException(IdentityErrors.SESSION_NOT_FOUND);
    }
  }

  // ── Password reset ──────────────────────────────────────────────────────

  /** Always the same answer; a code goes out only to an account that may sign in. */
  async forgotPassword(email: string): Promise<void> {
    const account = await this.repository.findByEmail(email);
    await this.otp.request(
      { purpose: 'reset-password', channel: 'email', recipient: email },
      { deliver: Boolean(account && canSignIn(account)) },
    );
  }

  /** Sets the new password and signs out every device (a reset usually means a leaked password). */
  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    await this.otp.verify({ purpose: 'reset-password', channel: 'email', recipient: email }, code);
    const account = await this.repository.findByEmail(email);
    if (!account || !canSignIn(account)) throw new IdentityException(IdentityErrors.OTP_INVALID);
    const userId = account._id.toHexString();
    await this.users.setPassword(userId, newPassword);
    if (!account.emailVerifiedAt) {
      await this.repository.updateById(account._id, { $set: { emailVerifiedAt: this.time.now() } });
    }
    await this.sessions.revokeAll(userId);
  }

  // ── E-mail verification ─────────────────────────────────────────────────

  async requestEmailVerification(userId: string): Promise<void> {
    const user = await this.users.findOrFail(userId);
    if (!user.email) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    if (user.emailVerifiedAt) throw new IdentityException(IdentityErrors.EMAIL_ALREADY_VERIFIED);
    await this.otp.request(
      { purpose: 'verify-email', channel: 'email', recipient: user.email, subjectId: userId },
      { deliver: true },
    );
  }

  async verifyEmail(userId: string, code: string): Promise<UserView> {
    const user = await this.users.findOrFail(userId);
    if (!user.email) throw new IdentityException(IdentityErrors.OTP_INVALID);
    if (user.emailVerifiedAt) throw new IdentityException(IdentityErrors.EMAIL_ALREADY_VERIFIED);
    await this.otp.verify(
      { purpose: 'verify-email', channel: 'email', recipient: user.email, subjectId: userId },
      code,
    );
    const updated = await this.repository.updateById(userId, { $set: { emailVerifiedAt: this.time.now() } });
    return this.users.view(updated!);
  }

  // ── Contact changes, confirmed by a code sent to the new address ────────

  async requestContactChange(userId: string, contact: Contact): Promise<void> {
    const user = await this.users.findOrFail(userId);
    const current = contact.channel === 'sms' ? user.phone : user.email;
    if (current === contact.recipient) throw new IdentityException(IdentityErrors.CONTACT_UNCHANGED);
    const taken = await this.findByContact(contact);
    if (taken && !taken._id.equals(user._id)) throw new IdentityException(this.takenError(contact));
    await this.otp.request({ purpose: this.changePurpose(contact), ...contact, subjectId: userId }, { deliver: true });
  }

  async confirmContactChange(userId: string, contact: Contact, code: string): Promise<UserView> {
    await this.otp.verify({ purpose: this.changePurpose(contact), ...contact, subjectId: userId }, code);
    const now = this.time.now();
    const set =
      contact.channel === 'sms'
        ? { phone: contact.recipient, phoneVerifiedAt: now }
        : { email: contact.recipient, emailVerifiedAt: now };
    // Someone may have taken the address since the code was sent: the unique index decides (409).
    const updated = await this.repository.updateById(userId, { $set: set });
    if (!updated) throw new IdentityException(IdentityErrors.USER_NOT_FOUND);
    return this.users.view(updated);
  }

  // ── Shared ──────────────────────────────────────────────────────────────

  /**
   * The one way a session starts: reactivates a self-deactivated or deletion-pending account (signing
   * in cancels a deletion), records the sign-in, issues the token pair and registers the device.
   */
  private async signIn(account: UserDoc, device?: DeviceDto): Promise<AuthResult> {
    const userId = account._id.toHexString();
    let user = account;
    if (account.status === 'deactivated' || account.status === 'deletion_pending') {
      user = await this.users.reactivate(userId);
      this.logger.log({ userId, from: account.status }, 'Account reactivated by sign-in');
    }
    user = (await this.repository.recordSuccessfulLogin(account._id, this.time.now())) ?? user;
    const context = RequestContext.current();
    const pair = await this.sessions.start({
      userId,
      role: user.role,
      device: device?.label || context?.userAgent || 'Unknown device',
      ip: context?.ip ?? null,
    });
    if (device?.pushToken && device.platform && isReachable(user)) {
      await this.devices
        ?.register(userId, {
          token: device.pushToken,
          platform: device.platform,
          appVersion: device.appVersion,
          sessionId: pair.sessionId,
        })
        .catch((err: unknown) => this.logger.warn({ err, userId }, 'Push token not registered at sign-in'));
    }
    return { ...pair, user: await this.users.view(user) };
  }

  private findByContact(contact: Contact): Promise<UserDoc | null> {
    return contact.channel === 'sms'
      ? this.repository.findByPhone(contact.recipient)
      : this.repository.findByEmail(contact.recipient);
  }

  private changePurpose(contact: Contact) {
    return contact.channel === 'sms' ? ('change-phone' as const) : ('change-email' as const);
  }

  private takenError(contact: Contact) {
    return contact.channel === 'sms' ? IdentityErrors.PHONE_TAKEN : IdentityErrors.EMAIL_TAKEN;
  }
}
