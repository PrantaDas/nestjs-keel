import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { authConfig } from '@/config/configuration';
import { AuthErrors, AuthException } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import type { AccessTokenPayload, AuthUser, IssuedToken, RefreshTokenPayload, Role } from './auth.types';
import { parseDurationSeconds } from './duration';

export interface IssuedRefreshToken extends IssuedToken {
  jti: string;
}

/**
 * Issues and verifies both tokens. Separate secrets and lifetimes: a leaked access secret cannot
 * mint refresh tokens and the other way round. Every timestamp (`iat`, `exp`, the verification
 * instant) comes from the injected clock, so tests can freeze time and clock skew between servers
 * is handled in one place (`JWT_CLOCK_TOLERANCE_SECONDS`).
 *
 * Rotation and reuse detection are the session store's job (identity module): this service only
 * proves a token is authentic, unexpired and of the right type, and hands back its claims.
 */
@Injectable()
export class TokenService {
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>,
    private readonly time: TimeService,
  ) {
    this.accessTtlSeconds = parseDurationSeconds(config.accessExpiresIn);
    this.refreshTtlSeconds = parseDurationSeconds(config.refreshExpiresIn);
  }

  async issueAccessToken(user: { id: string; role: Role; sessionId: string }): Promise<IssuedToken> {
    const iat = this.time.epochSeconds();
    const exp = iat + this.accessTtlSeconds;
    const payload: AccessTokenPayload = { sub: user.id, role: user.role, sid: user.sessionId, iat, exp, typ: 'access' };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.accessSecret,
      issuer: this.config.issuer,
      audience: this.config.audience,
    });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** A new refresh token for a session; `jti` is what the session stores to recognise it. */
  issueRefreshToken(userId: string, sessionId: string): Promise<IssuedRefreshToken> {
    return this.issueRefreshTokenWithJti(userId, sessionId, randomUUID());
  }

  /** Same, with a jti chosen by the session store (it is stored before the token is signed). */
  async issueRefreshTokenWithJti(userId: string, sessionId: string, jti: string): Promise<IssuedRefreshToken> {
    const iat = this.time.epochSeconds();
    const exp = iat + this.refreshTtlSeconds;
    const payload: RefreshTokenPayload = { sub: userId, sid: sessionId, jti, iat, exp, typ: 'refresh' };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.refreshSecret,
      issuer: this.config.issuer,
      audience: this.config.audience,
    });
    return { token, jti, expiresAt: new Date(exp * 1000) };
  }

  /** Verifies an access token; expired, tampered, wrong-secret or wrong-type tokens become 401s. */
  async verifyAccessToken(token: string): Promise<AuthUser> {
    const payload = await this.verify<AccessTokenPayload>(token, this.config.accessSecret);
    if (payload.typ !== 'access' || !payload.sid) throw new AuthException(AuthErrors.INVALID_TOKEN);
    return { id: payload.sub, role: payload.role, sessionId: payload.sid };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    const payload = await this.verify<RefreshTokenPayload>(token, this.config.refreshSecret);
    if (payload.typ !== 'refresh' || !payload.sid || !payload.jti) throw new AuthException(AuthErrors.INVALID_TOKEN);
    return payload;
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, {
        secret,
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['HS256'],
        clockTimestamp: this.time.epochSeconds(),
        clockTolerance: this.config.clockToleranceSeconds,
      });
    } catch (error) {
      if (error instanceof TokenExpiredError) throw new AuthException(AuthErrors.TOKEN_EXPIRED);
      throw new AuthException(AuthErrors.INVALID_TOKEN);
    }
  }

  /** Extracts the token from `Bearer <token>`; undefined when absent or malformed. */
  static extractBearer(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
  }

  /** SHA-256 hex of an API key (`API_KEYS` stores only this). */
  static hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /** Constant-time comparison of two hex digests of equal length. */
  static sameDigest(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
  }
}
