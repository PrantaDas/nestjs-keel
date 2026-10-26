import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_AUTH_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY } from './auth.decorators';
import { AuthUser, Role } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Permission } from './permissions';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';

function contextFor(metadata: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const handler = () => undefined;
  for (const [key, value] of Object.entries(metadata)) Reflect.defineMetadata(key, value, handler);
  const request: { headers: Record<string, string>; user?: AuthUser; apiClient?: { name: string } } = {
    headers: { authorization: 'Bearer token', ...headers },
  };
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const principal = (role: Role): AuthUser => ({ id: 'u1', role, sessionId: 's1' });

describe('JwtAuthGuard', () => {
  let tokens: { verifyAccessToken: jest.Mock };
  let access: { validate: jest.Mock };
  let guard: JwtAuthGuard;
  const apiKey = 'machine-key-0123456789';

  beforeEach(() => {
    tokens = { verifyAccessToken: jest.fn() };
    access = { validate: jest.fn((user: AuthUser) => Promise.resolve(user)) };
    guard = new JwtAuthGuard(new Reflector(), tokens as unknown as TokenService, access, {
      apiKeys: { billing: TokenService.hashApiKey(apiKey) },
    } as never);
  });

  it('skips public routes without touching the token', async () => {
    await expect(guard.canActivate(contextFor({ [IS_PUBLIC_KEY]: true }).context)).resolves.toBe(true);
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('asks the access validator and uses the role it returns (a demotion applies at once)', async () => {
    tokens.verifyAccessToken.mockResolvedValue(principal(Role.SUPER_ADMIN));
    access.validate.mockResolvedValue(principal(Role.ADMIN));
    const { context, request } = contextFor();
    await guard.canActivate(context);
    expect(request.user?.role).toBe(Role.ADMIN);
  });

  it('propagates a refusal from the validator (revoked session)', async () => {
    tokens.verifyAccessToken.mockResolvedValue(principal(Role.USER));
    access.validate.mockRejectedValue(new Error('revoked'));
    await expect(guard.canActivate(contextFor().context)).rejects.toThrow('revoked');
  });

  it('refuses a request without a bearer token', async () => {
    await expect(guard.canActivate(contextFor({}, { authorization: '' }).context)).rejects.toMatchObject({
      error: 'MISSING_BEARER_TOKEN',
    });
  });

  it('accepts a configured API key on @ApiKeyAuth routes and names the client', async () => {
    const { context, request } = contextFor({ [API_KEY_AUTH_KEY]: true }, { 'x-api-key': apiKey });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.apiClient).toEqual({ name: 'billing' });
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a wrong API key', async () => {
    const { context } = contextFor({ [API_KEY_AUTH_KEY]: true }, { 'x-api-key': 'nope' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ error: 'INVALID_API_KEY' });
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const withUser = (role: Role, metadata: Record<string, unknown>) => {
    const { context, request } = contextFor(metadata);
    request.user = principal(role);
    return context;
  };

  it('lets anyone through routes without roles or permissions', () => {
    expect(guard.canActivate(withUser(Role.USER, {}))).toBe(true);
  });

  it('enforces roles', () => {
    expect(guard.canActivate(withUser(Role.ADMIN, { [ROLES_KEY]: [Role.ADMIN] }))).toBe(true);
    expect(() => guard.canActivate(withUser(Role.USER, { [ROLES_KEY]: [Role.ADMIN] }))).toThrow();
  });

  it('enforces permissions from the role table', () => {
    const metadata = { [PERMISSIONS_KEY]: [Permission.OPS_WRITE] };
    expect(guard.canActivate(withUser(Role.SUPER_ADMIN, metadata))).toBe(true);
    expect(() => guard.canActivate(withUser(Role.ADMIN, metadata))).toThrow();
  });
});
