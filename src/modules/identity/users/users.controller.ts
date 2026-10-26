import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/auth/auth.decorators';
import type { AuthUser } from '@/common/auth/auth.types';
import { DeviceRegistry } from '@/common/contracts/device-registry.contract';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { SystemErrors } from '@/common/exceptions';
import { ApiEnvelope, ApiEnvelopeNull, ApiNoContent, ApiStandardErrors } from '@/common/swagger';
import { OtpThrottle } from '@/infra/security/throttle.decorators';
import { AuthService } from '../auth/auth.service';
import { DeviceDto } from '../auth/dto/auth.dto';
import { IdentityErrors } from '../identity.errors';
import {
  AvatarUploadDto,
  ChangePasswordDto,
  ConfirmAvatarDto,
  ConfirmEmailChangeDto,
  ConfirmPhoneChangeDto,
  ConfirmWithPasswordDto,
  RequestEmailChangeDto,
  RequestPhoneChangeDto,
  UpdateProfileDto,
} from './dto/user.dto';
import { AvatarUploadResponse, UserResponse } from './dto/user.responses';
import { UsersService } from './users.service';

const CODE_SEND_ERRORS = [
  IdentityErrors.OTP_RESEND_TOO_SOON,
  IdentityErrors.OTP_SEND_LIMIT,
  SystemErrors.INTEGRATION_NOT_CONFIGURED,
] as const;

/** The signed-in person's own account. */
@ApiTags('Users · Me')
@ApiBearerAuth()
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly devices: DeviceRegistry,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My account', operationId: 'usersMeGet' })
  @ApiEnvelope(UserResponse)
  @ResponseMessage('Account loaded.')
  me(@CurrentUser('id') userId: string) {
    return this.users.me(userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my name, language or time zone', operationId: 'usersMeUpdate' })
  @ApiEnvelope(UserResponse)
  @ResponseMessage('Profile updated.')
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  @Post('avatar/upload-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a URL to upload a profile picture to (direct to storage)',
    operationId: 'usersMeAvatarUploadUrl',
  })
  @ApiEnvelope(AvatarUploadResponse)
  @ApiStandardErrors(SystemErrors.INTEGRATION_NOT_CONFIGURED)
  @ResponseMessage('Upload link ready.')
  avatarUploadUrl(@CurrentUser('id') userId: string, @Body() dto: AvatarUploadDto) {
    return this.users.createAvatarUpload(userId, dto);
  }

  @Put('avatar')
  @ApiOperation({ summary: 'Use the uploaded picture as my profile picture', operationId: 'usersMeAvatarSet' })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(IdentityErrors.AVATAR_UPLOAD_MISSING)
  @ResponseMessage('Profile picture updated.')
  setAvatar(@CurrentUser('id') userId: string, @Body() dto: ConfirmAvatarDto) {
    return this.users.confirmAvatar(userId, dto.key);
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'Remove my profile picture', operationId: 'usersMeAvatarRemove' })
  @ApiEnvelope(UserResponse)
  @ResponseMessage('Profile picture removed.')
  removeAvatar(@CurrentUser('id') userId: string) {
    return this.users.removeAvatar(userId);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change (or set) my password; signs out my other devices',
    operationId: 'usersMePasswordChange',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.PASSWORD_INCORRECT)
  @ResponseMessage('Password changed. Your other devices were signed out.')
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto): Promise<null> {
    await this.users.changePassword(user, dto.currentPassword, dto.newPassword);
    return null;
  }

  @Post('email')
  @OtpThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start changing my e-mail: a code goes to the new address',
    operationId: 'usersMeEmailChange',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.CONTACT_UNCHANGED, IdentityErrors.EMAIL_TAKEN, ...CODE_SEND_ERRORS)
  @ResponseMessage('A code is on its way to the new address.')
  async requestEmailChange(@CurrentUser('id') userId: string, @Body() dto: RequestEmailChangeDto): Promise<null> {
    await this.auth.requestContactChange(userId, { channel: 'email', recipient: dto.email });
    return null;
  }

  @Post('email/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm the new e-mail with its code', operationId: 'usersMeEmailConfirm' })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(IdentityErrors.OTP_INVALID, IdentityErrors.OTP_TOO_MANY_ATTEMPTS, IdentityErrors.EMAIL_TAKEN)
  @ResponseMessage('Your email address was changed.')
  confirmEmailChange(@CurrentUser('id') userId: string, @Body() dto: ConfirmEmailChangeDto) {
    return this.auth.confirmContactChange(userId, { channel: 'email', recipient: dto.email }, dto.code);
  }

  @Post('phone')
  @OtpThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start changing (or adding) my phone: a code goes to the new number',
    operationId: 'usersMePhoneChange',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.CONTACT_UNCHANGED, IdentityErrors.PHONE_TAKEN, ...CODE_SEND_ERRORS)
  @ResponseMessage('A code is on its way to the new number.')
  async requestPhoneChange(@CurrentUser('id') userId: string, @Body() dto: RequestPhoneChangeDto): Promise<null> {
    await this.auth.requestContactChange(userId, { channel: 'sms', recipient: dto.phone });
    return null;
  }

  @Post('phone/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm the new phone number with its code', operationId: 'usersMePhoneConfirm' })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(IdentityErrors.OTP_INVALID, IdentityErrors.OTP_TOO_MANY_ATTEMPTS, IdentityErrors.PHONE_TAKEN)
  @ResponseMessage('Your phone number was changed.')
  confirmPhoneChange(@CurrentUser('id') userId: string, @Body() dto: ConfirmPhoneChangeDto) {
    return this.auth.confirmContactChange(userId, { channel: 'sms', recipient: dto.phone }, dto.code);
  }

  @Put('device')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Register or refresh this device for push notifications',
    operationId: 'usersMeDeviceRegister',
  })
  @ApiNoContent()
  async registerDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto): Promise<void> {
    if (!dto.pushToken || !dto.platform) return;
    await this.devices.register(user.id, {
      token: dto.pushToken,
      platform: dto.platform,
      appVersion: dto.appVersion,
      sessionId: user.sessionId,
    });
  }

  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate my account (signing in again restores it)', operationId: 'usersMeDeactivate' })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.PASSWORD_INCORRECT)
  @ResponseMessage('Your account is deactivated. Sign in again any time to restore it.')
  async deactivate(@CurrentUser('id') userId: string, @Body() dto: ConfirmWithPasswordDto): Promise<null> {
    await this.users.deactivateSelf(userId, dto.password);
    return null;
  }

  @Post('deletion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule my account for deletion after the grace period (signing in cancels it)',
    operationId: 'usersMeDeletionRequest',
  })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(IdentityErrors.PASSWORD_INCORRECT, IdentityErrors.ACCOUNT_DELETION_PENDING)
  @ResponseMessage('Your account will be deleted at the date shown. Sign in before then to keep it.')
  requestDeletion(@CurrentUser() user: AuthUser, @Body() dto: ConfirmWithPasswordDto) {
    return this.users.requestDeletion(user, dto.password);
  }

  @Delete('deletion')
  @ApiOperation({ summary: 'Cancel the scheduled deletion of my account', operationId: 'usersMeDeletionCancel' })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(IdentityErrors.DELETION_NOT_PENDING)
  @ResponseMessage('Your account will not be deleted.')
  cancelDeletion(@CurrentUser('id') userId: string) {
    return this.users.cancelDeletion(userId);
  }
}
