import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthErrors, AuthException, ForbiddenActionException } from '@/common/exceptions';
import { PERMISSIONS_KEY, requestOf, ROLES_KEY } from './auth.decorators';
import { Role } from './auth.types';
import { hasPermissions, Permission } from './permissions';

/** Global guard: enforces `@Roles(...)` and `@RequirePermissions(...)`. Runs after JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const type = context.getType<string>();
    if (type !== 'http' && type !== 'graphql') return true;

    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? [];
    const permissions = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets) ?? [];
    if (!roles.length && !permissions.length) return true;

    const { user } = requestOf(context);
    if (!user) throw new AuthException(AuthErrors.UNAUTHENTICATED);
    if (roles.length && !roles.includes(user.role)) throw new ForbiddenActionException();
    if (!hasPermissions(user.role, permissions)) throw new ForbiddenActionException();
    return true;
  }
}
