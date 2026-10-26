import type { Socket } from 'socket.io';
import { AccessErrors, AccessException } from '@/common/auth/auth-access.errors';
import { AuthUser, Role } from '@/common/auth/auth.types';
import type { TokenService } from '@/common/auth/token.service';
import { AuthErrors, AuthException } from '@/common/exceptions';
import { SocketAuthMiddleware, SocketData } from './socket-auth.middleware';

type HandshakeError = Error & { data?: { error: string } };

function socketWith(auth: Record<string, unknown>, headers: Record<string, string> = {}) {
  return { handshake: { auth, headers }, data: {} } as unknown as Socket;
}

/** Runs the middleware and resolves with what it passed to `next`. */
function handshake(middleware: SocketAuthMiddleware, socket: Socket): Promise<HandshakeError | undefined> {
  return new Promise((resolve) => middleware.use(socket, (err) => resolve(err)));
}

describe('SocketAuthMiddleware', () => {
  const claims: AuthUser = { id: 'u1', role: Role.SUPER_ADMIN, sessionId: 's1' };
  let tokens: { verifyAccessToken: jest.Mock };
  let access: { validate: jest.Mock };
  let middleware: SocketAuthMiddleware;

  beforeEach(() => {
    tokens = { verifyAccessToken: jest.fn().mockResolvedValue(claims) };
    access = { validate: jest.fn((user: AuthUser) => Promise.resolve(user)) };
    middleware = new SocketAuthMiddleware(tokens as unknown as TokenService, access);
  });

  it('checks the session with the access validator and keeps the role it returns', async () => {
    access.validate.mockResolvedValue({ ...claims, role: Role.ADMIN });
    const socket = socketWith({ token: 'jwt', timeZone: 'Asia/Kolkata' });
    await expect(handshake(middleware, socket)).resolves.toBeUndefined();
    expect(tokens.verifyAccessToken).toHaveBeenCalledWith('jwt');
    expect(access.validate).toHaveBeenCalledWith(claims);
    expect(socket.data as SocketData).toEqual({ user: { ...claims, role: Role.ADMIN }, timeZone: 'Asia/Kolkata' });
  });

  it('accepts the Authorization header as well', async () => {
    await expect(handshake(middleware, socketWith({}, { authorization: 'Bearer jwt' }))).resolves.toBeUndefined();
    expect(tokens.verifyAccessToken).toHaveBeenCalledWith('jwt');
  });

  it.each([
    ['a revoked session', AccessErrors.SESSION_REVOKED],
    ['a disabled account', AccessErrors.ACCOUNT_DISABLED],
  ])('refuses %s with the error envelope', async (_label, definition) => {
    access.validate.mockRejectedValue(new AccessException(definition));
    const socket = socketWith({ token: 'jwt' });
    const err = await handshake(middleware, socket);
    expect(err?.data).toMatchObject({ success: false, error: definition.key, errorCode: definition.code });
    expect((socket.data as Partial<SocketData>).user).toBeUndefined();
  });

  it('never asks the validator about a bad or missing token', async () => {
    tokens.verifyAccessToken.mockRejectedValue(new AuthException(AuthErrors.INVALID_TOKEN));
    expect((await handshake(middleware, socketWith({ token: 'forged' })))?.data?.error).toBe('INVALID_TOKEN');
    expect((await handshake(middleware, socketWith({})))?.data?.error).toBe('MISSING_BEARER_TOKEN');
    expect(access.validate).not.toHaveBeenCalled();
  });

  it('fails closed when no access validator is bound', async () => {
    const unbound = new SocketAuthMiddleware(tokens as unknown as TokenService);
    const err = await handshake(unbound, socketWith({ token: 'jwt' }));
    expect(err?.data?.error).toBe('INTERNAL_ERROR');
  });
});
