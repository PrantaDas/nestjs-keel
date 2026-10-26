import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import type { AuthUser, Role } from './auth.types';
import type { Permission } from './permissions';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';
export const API_KEY_AUTH_KEY = 'auth:apiKey';

/** Opts a route (or controller) out of authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route (or controller) to the listed roles. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** Requires every listed permission (`ROLE_PERMISSIONS`); combine with `@Roles` or use alone. */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Machine-to-machine route: authenticated with `x-api-key` (keys in `API_KEYS`), not a user token.
 * The calling client is available as `request.apiClient`.
 */
export const ApiKeyAuth = (): MethodDecorator & ClassDecorator => SetMetadata(API_KEY_AUTH_KEY, true);

/** The request of an HTTP or GraphQL context. */
export function requestOf(ctx: ExecutionContext): Request {
  if (ctx.getType<string>() === 'graphql') return GqlExecutionContext.create(ctx).getContext<{ req: Request }>().req;
  return ctx.switchToHttp().getRequest<Request>();
}

/** Injects the authenticated user (or one of its fields), over REST and GraphQL. */
export const CurrentUser = createParamDecorator((field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
  const user = requestOf(ctx).user;
  return field ? user?.[field] : user;
});
