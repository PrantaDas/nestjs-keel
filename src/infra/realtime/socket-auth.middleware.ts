import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AccessValidator } from '@/common/auth/access-validator';
import type { AuthUser } from '@/common/auth/auth.types';
import { TokenService } from '@/common/auth/token.service';
import { AuthErrors, AuthException } from '@/common/exceptions';
import { mapException } from '@/common/exceptions/exception-mapper';
import type { TimeZone } from '@/common/time/time.types';
import { normalizeTimeZone } from '@/common/time/zoned-time';

export interface SocketData {
  user: AuthUser;
  /** Device zone from `auth.timeZone` or the `X-Timezone` header; undefined when absent/invalid. */
  timeZone?: TimeZone;
}

/**
 * Handshake auth: the client sends `auth: { token, timeZone }` (preferred) or `Authorization` /
 * `X-Timezone` headers. Same checks as the HTTP guard: the JWT, then the identity module's
 * `AccessValidator` (live session, active staff account, current role), so a revoked session or
 * a disabled staff member cannot open a socket with a still-unexpired access token.
 * On failure the client gets `connect_error` with `err.data` holding the standard error envelope.
 */
@Injectable()
export class SocketAuthMiddleware {
  private readonly logger = new Logger(SocketAuthMiddleware.name);

  constructor(
    private readonly tokens: TokenService,
    // Provided globally by identity in every process that serves sockets. Optional only so that
    // processes without sockets (and infra tests) can load CoreModule alone; without it every
    // handshake is refused (fail closed).
    @Optional() private readonly access?: AccessValidator,
  ) {}

  readonly use = (socket: Socket, next: (err?: Error) => void): void => {
    this.authenticate(socket)
      .then(
        (user) => {
          const auth = socket.handshake.auth as { timeZone?: unknown } | undefined;
          const data = socket.data as SocketData;
          data.user = user;
          data.timeZone = normalizeTimeZone(auth?.timeZone ?? socket.handshake.headers['x-timezone']) ?? undefined;
          next();
        },
        (exception: unknown) => {
          const { body, isServerError, dependency } = mapException(exception);
          // A database / Redis outage is expected to fail handshakes (503 envelope): warn, not error.
          if (dependency) this.logger.warn({ err: exception, dependency }, 'Socket handshake failed: dependency down');
          else if (isServerError) this.logger.error({ err: exception }, 'Socket handshake failed');
          next(Object.assign(new Error(body.errorMessage), { data: body }));
        },
      )
      // `next` runs the connection handlers synchronously: a throw there must not become an
      // unhandled rejection (which ends the process).
      .catch((err: unknown) => this.logger.error({ err, socketId: socket.id }, 'Socket connection setup failed'));
  };

  private async authenticate(socket: Socket): Promise<AuthUser> {
    const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const token =
      (typeof authToken === 'string' && authToken) ||
      TokenService.extractBearer(socket.handshake.headers.authorization);
    if (!token) throw new AuthException(AuthErrors.MISSING_BEARER_TOKEN);
    const claims = await this.tokens.verifyAccessToken(token);
    if (!this.access) throw new Error('AccessValidator is not provided: socket handshakes are refused');
    return this.access.validate(claims);
  }
}
