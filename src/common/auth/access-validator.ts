import type { AuthUser } from './auth.types';

/**
 * Port between the guards (common) and the identity module that owns sessions and accounts.
 * Called for every authenticated request and socket handshake after the token signature is
 * verified: rejects revoked or expired sessions and disabled accounts, and returns the principal
 * with its current role (a demoted admin loses the old role at once, not when the token expires).
 *
 * Provided globally by the identity module (`{ provide: AccessValidator, useExisting: SessionService }`)
 * and must throw an `AuthException` when access is refused.
 */
export abstract class AccessValidator {
  abstract validate(user: AuthUser): Promise<AuthUser>;
}
