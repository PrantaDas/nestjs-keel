/**
 * One `users` collection holds people and staff; a role says which (ADR 0005). Roles are coarse;
 * fine-grained checks use permissions (`permissions.ts`).
 */
export enum Role {
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

/** Roles that may use the admin API. */
export const STAFF_ROLES: readonly Role[] = [Role.ADMIN, Role.SUPER_ADMIN];

export const isStaffRole = (role: Role | string | undefined): boolean => STAFF_ROLES.includes(role as Role);

/** Claims of an access token. Small on purpose: it travels with every request. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  role: Role;
  /** Session id: the guard checks the session is still live, so revocation is immediate. */
  sid: string;
  /** Issued-at and expiry, epoch seconds, taken from the injected clock (never `Date.now()`). */
  iat: number;
  exp: number;
  typ: 'access';
}

/** Claims of a refresh token (separate secret, longer lifetime). */
export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  /** Rotation counter id: the session accepts exactly one live refresh token, the latest. */
  jti: string;
  iat: number;
  exp: number;
  typ: 'refresh';
}

/** The authenticated principal on `request.user` and `socket.data.user`. */
export interface AuthUser {
  id: string;
  role: Role;
  sessionId: string;
}

/** A machine client authenticated with an API key (`@ApiKeyAuth()` routes). */
export interface ApiClient {
  name: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

/** What sign-in, OTP sign-in and refresh all return. */
export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}
