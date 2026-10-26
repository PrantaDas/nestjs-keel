import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '@/common/auth/auth.decorators';
import type { AuthUser } from '@/common/auth/auth.types';
import { Permission } from '@/common/auth/permissions';
import { Audit } from '@/common/decorators/audit.decorator';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { ParseObjectIdPipe } from '@/common/pipes/parse-object-id.pipe';
import { ApiEnvelope, ApiPaginated, ApiStandardErrors } from '@/common/swagger';
import { SignedOutResponse } from '../auth/dto/auth.responses';
import { IdentityErrors } from '../identity.errors';
import { AdminUpdateUserDto, AdminUserQueryDto } from './dto/admin-user.dto';
import { AdminUserDetailResponse, AdminUserResponse } from './dto/user.responses';
import { UsersService } from './users.service';

/** Account administration. Every write is audited; managing admins needs a super admin. */
@ApiTags('Admin · Users')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List accounts (filters, prefix search, sorting, pages)', operationId: 'adminUsersList' })
  @ApiPaginated(AdminUserResponse)
  @ResponseMessage('Accounts loaded.')
  list(@Query() query: AdminUserQueryDto) {
    return this.users.adminList(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'One account with its sessions', operationId: 'adminUsersGet' })
  @ApiEnvelope(AdminUserDetailResponse)
  @ApiStandardErrors(IdentityErrors.USER_NOT_FOUND)
  @ResponseMessage('Account loaded.')
  detail(@Param('id', ParseObjectIdPipe) id: string) {
    return this.users.adminDetail(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.USERS_WRITE)
  @Audit({ action: 'user.update', resource: 'user' })
  @ApiOperation({ summary: 'Rename an account or change its role', operationId: 'adminUsersUpdate' })
  @ApiEnvelope(AdminUserResponse)
  @ApiStandardErrors(
    IdentityErrors.USER_NOT_FOUND,
    IdentityErrors.ROLE_CHANGE_FORBIDDEN,
    IdentityErrors.CANNOT_CHANGE_SELF,
    IdentityErrors.LAST_SUPER_ADMIN,
  )
  @ResponseMessage('Account updated.')
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: AdminUpdateUserDto) {
    return this.users.adminUpdate(actor, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.USERS_WRITE)
  @Audit({ action: 'user.disable', resource: 'user' })
  @ApiOperation({
    summary: 'Disable an account: signed out everywhere, no sign-in, no messages',
    operationId: 'adminUsersDisable',
  })
  @ApiEnvelope(AdminUserResponse)
  @ApiStandardErrors(
    IdentityErrors.USER_NOT_FOUND,
    IdentityErrors.ROLE_CHANGE_FORBIDDEN,
    IdentityErrors.CANNOT_CHANGE_SELF,
    IdentityErrors.LAST_SUPER_ADMIN,
  )
  @ResponseMessage('Account disabled.')
  disable(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.users.adminDisable(actor, id);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.USERS_WRITE)
  @Audit({ action: 'user.enable', resource: 'user' })
  @ApiOperation({ summary: 'Re-enable an account', operationId: 'adminUsersEnable' })
  @ApiEnvelope(AdminUserResponse)
  @ApiStandardErrors(IdentityErrors.USER_NOT_FOUND, IdentityErrors.ROLE_CHANGE_FORBIDDEN)
  @ResponseMessage('Account enabled.')
  enable(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.users.adminEnable(actor, id);
  }

  @Delete(':id/sessions')
  @RequirePermissions(Permission.SESSIONS_REVOKE)
  @Audit({ action: 'user.sessions.revoke', resource: 'user' })
  @ApiOperation({ summary: 'Sign an account out of every device', operationId: 'adminUsersSessionsRevoke' })
  @ApiEnvelope(SignedOutResponse)
  @ApiStandardErrors(IdentityErrors.USER_NOT_FOUND, IdentityErrors.ROLE_CHANGE_FORBIDDEN)
  @ResponseMessage('Account signed out everywhere.')
  async revokeSessions(@CurrentUser() actor: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return { revoked: await this.users.adminRevokeSessions(actor, id) };
  }
}
