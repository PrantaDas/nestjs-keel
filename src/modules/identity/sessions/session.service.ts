import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { AccessValidator } from '@/common/auth/access-validator';
import { AccessErrors, AccessException } from '@/common/auth/auth-access.errors';
import type { AuthUser, Role, TokenPair } from '@/common/auth/auth.types';
import { TokenService } from '@/common/auth/token.service';
import { DeviceRegistry } from '@/common/contracts/device-registry.contract';
import { AuthException } from '@/common/exceptions';
import { authConfig } from '@/config/configuration';
import { RealtimeEmitter } from '@/infra/realtime/realtime-emitter.service';
import { IdentityErrors, IdentityException } from '../identity.errors';
import { SessionRecord, SessionStore } from './session.store';

export interface SessionStart {
  userId: string;
  role: Role;
  /** Label shown in the device list. */
  device: string;
  ip: string | null;
}

/**
 * Sessions and token pairs. One session per signed-in device; its refresh token is rotated on every
 * refresh and a reused (already rotated) refresh token revokes the session, which is how a stolen
 * token is caught: the thief and the owner cannot both keep refreshing. Also the `AccessValidator`
 * every guard and socket handshake calls, so a revoked session stops working at once.
 */
@Injectable()
export class SessionService extends AccessValidator {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly store: SessionStore,
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeEmitter,
    @Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>,
    // Provided by the notifications module; absent in processes that do not load it.
    @Optional() private readonly devices?: DeviceRegistry,
  ) {
    super();
  }

  /** Starts a session and issues its first token pair. Old sessions beyond the limit are signed out. */
  async start(input: SessionStart): Promise<TokenPair> {
    const jti = this.store.newJti();
    const session = await this.store.create({ ...input, jti, ttlSeconds: this.tokens.refreshTtlSeconds });
    const evicted = await this.store.enforceLimit(input.userId, this.config.maxSessionsPerUser);
    if (evicted.length) await this.afterRevoke(input.userId, evicted);
    return this.issue(session, jti);
  }

  /**
   * Rotates the refresh token. `isActive` re-checks the account (a disabled account cannot
   * refresh even if its session somehow survived).
   */
  async refresh(refreshToken: string, isActive: (userId: string) => Promise<boolean>): Promise<TokenPair> {
    let claims;
    try {
      claims = await this.tokens.verifyRefreshToken(refreshToken);
    } catch (error) {
      if (error instanceof AuthException) throw new IdentityException(IdentityErrors.INVALID_REFRESH_TOKEN);
      throw error;
    }
    const nextJti = this.store.newJti();
    const outcome = await this.store.rotate(claims.sub, claims.sid, claims.jti, nextJti, this.tokens.refreshTtlSeconds);
    if (outcome.status === 'missing') throw new IdentityException(IdentityErrors.INVALID_REFRESH_TOKEN);
    if (outcome.status === 'reused') {
      this.logger.warn({ userId: claims.sub, sessionId: claims.sid }, 'Refresh token reuse detected: session revoked');
      await this.afterRevoke(claims.sub, [claims.sid]);
      throw new IdentityException(IdentityErrors.REFRESH_TOKEN_REUSED);
    }
    if (!(await isActive(claims.sub))) {
      await this.revoke(claims.sub, claims.sid);
      throw new IdentityException(IdentityErrors.ACCOUNT_DEACTIVATED);
    }
    return this.issue(outcome.session, nextJti);
  }

  /** `AccessValidator`: the session must exist and belong to the token's user; its role wins. */
  async validate(user: AuthUser): Promise<AuthUser> {
    const session = await this.store.get(user.sessionId);
    if (!session || session.userId !== user.id) throw new AccessException(AccessErrors.SESSION_REVOKED);
    return { id: user.id, role: session.role, sessionId: session.id };
  }

  list(userId: string): Promise<SessionRecord[]> {
    return this.store.list(userId);
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const revoked = await this.store.revoke(userId, sessionId);
    if (revoked) await this.afterRevoke(userId, [sessionId]);
    return revoked;
  }

  /** Sign out everywhere (optionally except the current device); returns how many were revoked. */
  async revokeAll(userId: string, keep?: string): Promise<number> {
    const ids = await this.store.revokeAll(userId, keep);
    if (ids.length) await this.afterRevoke(userId, ids);
    return ids.length;
  }

  setRole(userId: string, role: Role): Promise<void> {
    return this.store.setRole(userId, role);
  }

  private async issue(session: SessionRecord, jti: string): Promise<TokenPair> {
    const [access, refresh] = await Promise.all([
      this.tokens.issueAccessToken({ id: session.userId, role: session.role, sessionId: session.id }),
      this.tokens.issueRefreshTokenWithJti(session.userId, session.id, jti),
    ]);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
      sessionId: session.id,
    };
  }

  /** Open sockets of revoked sessions close now; their push tokens stop receiving. Best effort. */
  private async afterRevoke(userId: string, sessionIds: string[]): Promise<void> {
    this.realtime.disconnectSessions(sessionIds);
    await this.devices
      ?.removeForSessions(userId, sessionIds)
      .catch((err: unknown) => this.logger.warn({ err, userId }, 'Could not remove push tokens of revoked sessions'));
  }
}
