import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { authConfig } from '@/config/configuration';
import { RequestContext } from '@/common/context/request-context';
import { AuthErrors, AuthException } from '@/common/exceptions';
import { AccessValidator } from './access-validator';
import { AccessErrors, AccessException } from './auth-access.errors';
import { API_KEY_AUTH_KEY, IS_PUBLIC_KEY, requestOf } from './auth.decorators';
import { TokenService } from './token.service';

const API_KEY_HEADER = 'x-api-key';

/**
 * Global guard for REST and GraphQL: every route needs a valid access token unless `@Public()`.
 *
 * 1. `@ApiKeyAuth()` routes take an `x-api-key` instead (machine clients, compared by SHA-256 digest
 *    in constant time) and never a user token;
 * 2. otherwise the JWT signature, type and expiry are verified;
 * 3. the identity module (`AccessValidator`) confirms the session is still live and the account
 *    active, and supplies the current role, so sign-out and admin revocation take effect at once.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly apiKeys: Array<[name: string, digest: string]>;

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessValidator,
    @Inject(authConfig.KEY) config: ConfigType<typeof authConfig>,
  ) {
    this.apiKeys = Object.entries(config.apiKeys);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = context.getType<string>();
    if (type !== 'http' && type !== 'graphql') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = requestOf(context);
    if (this.reflector.getAllAndOverride<boolean>(API_KEY_AUTH_KEY, targets)) {
      const presented = request.headers[API_KEY_HEADER];
      const name = typeof presented === 'string' ? this.matchApiKey(presented) : undefined;
      if (!name) throw new AccessException(AccessErrors.INVALID_API_KEY);
      request.apiClient = { name };
      return true;
    }

    const token = TokenService.extractBearer(request.headers.authorization);
    if (!token) throw new AuthException(AuthErrors.MISSING_BEARER_TOKEN);
    const user = await this.access.validate(await this.tokens.verifyAccessToken(token));
    request.user = user;
    RequestContext.setUser(user);
    return true;
  }

  /** Name of the key whose digest matches; every configured key is compared (no early exit). */
  private matchApiKey(presented: string): string | undefined {
    const digest = TokenService.hashApiKey(presented);
    let match: string | undefined;
    for (const [name, expected] of this.apiKeys) if (TokenService.sameDigest(digest, expected)) match = name;
    return match;
  }
}
