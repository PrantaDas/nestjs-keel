import { JwtService } from '@nestjs/jwt';
import { AuthException } from '@/common/exceptions';
import { FixedClock } from '@/common/time/clock';
import { UTC_POLICY } from '@/common/time/time-policy';
import { TimeService } from '@/common/time/time.service';
import { Role } from './auth.types';
import { parseDurationSeconds } from './duration';
import { TokenService } from './token.service';

const config = {
  accessSecret: 'unit-access-secret-that-is-at-least-32-chars',
  accessExpiresIn: '15m',
  refreshSecret: 'unit-refresh-secret-that-is-at-least-32-chars',
  refreshExpiresIn: '30d',
  issuer: 'unit',
  audience: 'unit',
  clockToleranceSeconds: 5,
  maxSessionsPerUser: 10,
  maxFailedLogins: 5,
  lockoutSeconds: 900,
  deletionGraceDays: 30,
  apiKeys: {},
};

describe('parseDurationSeconds', () => {
  it.each([
    ['900', 900],
    ['90s', 90],
    ['15m', 900],
    ['12h', 43_200],
    ['30d', 2_592_000],
  ])('parses %s', (input, seconds) => expect(parseDurationSeconds(input)).toBe(seconds));

  it.each(['', '15 minutes', '-5m', '0', '1w'])('rejects %p at boot', (input) => {
    expect(() => parseDurationSeconds(input)).toThrow(/duration/);
  });
});

describe('TokenService', () => {
  const user = { id: 'u1', role: Role.USER, sessionId: 's1' };
  let clock: FixedClock;
  let tokens: TokenService;

  beforeEach(() => {
    clock = new FixedClock('2026-10-14T10:00:00Z');
    tokens = new TokenService(new JwtService(), config, new TimeService(clock, UTC_POLICY));
  });

  it('issues access tokens carrying sub, role and sid, expiring after the access lifetime', async () => {
    const issued = await tokens.issueAccessToken(user);
    expect(issued.expiresAt.toISOString()).toBe('2026-10-14T10:15:00.000Z');
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toEqual(user);
  });

  it('takes iat from the injected clock, not the machine clock', async () => {
    const { token } = await tokens.issueAccessToken(user);
    const claims = new JwtService().decode<{ iat: number; exp: number }>(token);
    expect(claims.iat).toBe(Date.UTC(2026, 9, 14, 10) / 1000);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('rejects an expired access token, allowing the configured clock skew', async () => {
    const { token } = await tokens.issueAccessToken(user);
    clock.advance(15 * 60_000 + 4_000); // 4 s past expiry, inside the 5 s tolerance
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual(user);
    clock.advance(2_000);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('rejects a tampered token', async () => {
    const { token } = await tokens.issueAccessToken(user);
    const [header, , signature] = token.split('.');
    const forgedClaims = Buffer.from(JSON.stringify({ sub: 'u1', role: Role.SUPER_ADMIN, sid: 's1' })).toString(
      'base64url',
    );
    await expect(tokens.verifyAccessToken(`${header}.${forgedClaims}.${signature}`)).rejects.toMatchObject({
      error: 'INVALID_TOKEN',
    });
  });

  it('rejects tokens signed with another secret', async () => {
    const forged = await new JwtService().signAsync(
      { sub: 'x', role: Role.SUPER_ADMIN, sid: 's', typ: 'access' },
      { secret: 'x'.repeat(40), issuer: 'unit', audience: 'unit' },
    );
    await expect(tokens.verifyAccessToken(forged)).rejects.toBeInstanceOf(AuthException);
  });

  it('never accepts a refresh token as an access token, or the other way round', async () => {
    const refresh = await tokens.issueRefreshToken('u1', 's1');
    const access = await tokens.issueAccessToken(user);
    await expect(tokens.verifyAccessToken(refresh.token)).rejects.toMatchObject({ error: 'INVALID_TOKEN' });
    await expect(tokens.verifyRefreshToken(access.token)).rejects.toMatchObject({ error: 'INVALID_TOKEN' });
  });

  it('issues refresh tokens with a unique jti and the refresh lifetime', async () => {
    const first = await tokens.issueRefreshToken('u1', 's1');
    const second = await tokens.issueRefreshToken('u1', 's1');
    expect(first.jti).not.toBe(second.jti);
    expect(first.expiresAt.toISOString()).toBe('2026-11-13T10:00:00.000Z');
    await expect(tokens.verifyRefreshToken(first.token)).resolves.toMatchObject({
      sub: 'u1',
      sid: 's1',
      jti: first.jti,
    });
  });

  it('extracts bearer tokens and compares API key digests in constant time', () => {
    expect(TokenService.extractBearer('Bearer abc')).toBe('abc');
    expect(TokenService.extractBearer('Basic abc')).toBeUndefined();
    const digest = TokenService.hashApiKey('k');
    expect(TokenService.sameDigest(digest, TokenService.hashApiKey('k'))).toBe(true);
    expect(TokenService.sameDigest(digest, TokenService.hashApiKey('j'))).toBe(false);
    expect(TokenService.sameDigest(digest, '')).toBe(false);
  });
});
