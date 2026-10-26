import type { ApiClient, AuthUser } from './auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Set by JwtAuthGuard on authenticated routes. */
      user?: AuthUser;
      /** Set by JwtAuthGuard on `@ApiKeyAuth()` routes. */
      apiClient?: ApiClient;
    }
  }
}

export {};
