import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '@/common/auth/auth.decorators';
import type { AuthUser } from '@/common/auth/auth.types';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { RequestErrors, RequestException, SystemErrors } from '@/common/exceptions';
import { ApiEnvelope, ApiEnvelopeArray, ApiEnvelopeNull, ApiNoContent, ApiStandardErrors } from '@/common/swagger';
import { AuthThrottle, OtpThrottle } from '@/infra/security/throttle.decorators';
import { IdentityErrors } from '../identity.errors';
import { UserResponse } from '../users/dto/user.responses';
import { AuthService, Contact } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  OtpRequestDto,
  OtpVerifyDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { AuthResponse, SessionResponse, SignedOutResponse, TokenPairResponse } from './dto/auth.responses';

const OTP_ERRORS = [
  IdentityErrors.OTP_RESEND_TOO_SOON,
  IdentityErrors.OTP_SEND_LIMIT,
  SystemErrors.INTEGRATION_NOT_CONFIGURED,
] as const;

/**
 * Sign-up, sign-in (password or one-time code), token refresh with rotation, sign-out, password
 * reset and e-mail verification. Public routes are throttled tighter than the rest of the API.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @AuthThrottle()
  @ApiOperation({ summary: 'Create an account with e-mail and password, and sign in', operationId: 'authRegister' })
  @ApiEnvelope(AuthResponse)
  @ApiStandardErrors(IdentityErrors.EMAIL_TAKEN)
  @ResponseMessage('Welcome! Your account is ready. Check your email for a code to confirm your address.')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with e-mail and password', operationId: 'authLogin' })
  @ApiEnvelope(AuthResponse)
  @ApiStandardErrors(
    IdentityErrors.INVALID_CREDENTIALS,
    IdentityErrors.ACCOUNT_LOCKED,
    IdentityErrors.ACCOUNT_DEACTIVATED,
  )
  @ResponseMessage('Signed in.')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('otp/request')
  @Public()
  @OtpThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a sign-in code by SMS or e-mail (same answer whether or not an account exists)',
    operationId: 'authOtpRequest',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(...OTP_ERRORS)
  @ResponseMessage('If an account uses this address, a code is on its way.')
  async requestCode(@Body() dto: OtpRequestDto): Promise<null> {
    await this.auth.requestLoginCode(contactOf(dto));
    return null;
  }

  @Post('otp/verify')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with a code received by SMS or e-mail', operationId: 'authOtpVerify' })
  @ApiEnvelope(AuthResponse)
  @ApiStandardErrors(IdentityErrors.OTP_INVALID, IdentityErrors.OTP_TOO_MANY_ATTEMPTS)
  @ResponseMessage('Signed in.')
  verifyCode(@Body() dto: OtpVerifyDto) {
    return this.auth.verifyLoginCode(contactOf(dto), dto.code, dto.device);
  }

  @Post('refresh')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair (the old refresh token stops working)',
    operationId: 'authRefresh',
  })
  @ApiEnvelope(TokenPairResponse)
  @ApiStandardErrors(
    IdentityErrors.INVALID_REFRESH_TOKEN,
    IdentityErrors.REFRESH_TOKEN_REUSED,
    IdentityErrors.ACCOUNT_DEACTIVATED,
  )
  @ResponseMessage('Session refreshed.')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of this device', operationId: 'authLogout' })
  @ApiEnvelope(SignedOutResponse)
  @ResponseMessage('Signed out.')
  async logout(@CurrentUser() user: AuthUser) {
    return { revoked: await this.auth.logout(user) };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of every device, this one included', operationId: 'authLogoutAll' })
  @ApiEnvelope(SignedOutResponse)
  @ResponseMessage('Signed out on every device.')
  async logoutAll(@CurrentUser() user: AuthUser) {
    return { revoked: await this.auth.logoutEverywhere(user) };
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devices this account is signed in on', operationId: 'authSessionsList' })
  @ApiEnvelopeArray(SessionResponse)
  @ResponseMessage('Signed-in devices loaded.')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign one device out', operationId: 'authSessionsRevoke' })
  @ApiNoContent()
  @ApiStandardErrors(IdentityErrors.SESSION_NOT_FOUND)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string): Promise<void> {
    await this.auth.revokeSession(user, sessionId);
  }

  @Post('password/forgot')
  @Public()
  @OtpThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'E-mail a password reset code (same answer for any address)',
    operationId: 'authPasswordForgot',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(...OTP_ERRORS)
  @ResponseMessage('If an account uses this email, a reset code is on its way.')
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<null> {
    await this.auth.forgotPassword(dto.email);
    return null;
  }

  @Post('password/reset')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with the e-mailed code (signs out every device)',
    operationId: 'authPasswordReset',
  })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.OTP_INVALID, IdentityErrors.OTP_TOO_MANY_ATTEMPTS)
  @ResponseMessage('Your password was changed. Sign in with the new one.')
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<null> {
    await this.auth.resetPassword(dto.email, dto.code, dto.newPassword);
    return null;
  }

  @Post('email/verify/request')
  @OtpThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'E-mail a code to confirm the account address', operationId: 'authEmailVerifyRequest' })
  @ApiEnvelopeNull()
  @ApiStandardErrors(IdentityErrors.EMAIL_ALREADY_VERIFIED, ...OTP_ERRORS)
  @ResponseMessage('A code is on its way to your email.')
  async requestEmailVerification(@CurrentUser('id') userId: string): Promise<null> {
    await this.auth.requestEmailVerification(userId);
    return null;
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm the account address with the e-mailed code', operationId: 'authEmailVerify' })
  @ApiEnvelope(UserResponse)
  @ApiStandardErrors(
    IdentityErrors.OTP_INVALID,
    IdentityErrors.OTP_TOO_MANY_ATTEMPTS,
    IdentityErrors.EMAIL_ALREADY_VERIFIED,
  )
  @ResponseMessage('Your email address is confirmed.')
  verifyEmail(@CurrentUser('id') userId: string, @Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(userId, dto.code);
  }
}

/** The address a code goes to; the DTO marks the field required for its channel. */
export function contactOf(dto: OtpRequestDto): Contact {
  const recipient = dto.channel === 'sms' ? dto.phone : dto.email;
  if (!recipient) {
    const field = dto.channel === 'sms' ? 'phone' : 'email';
    throw new RequestException(RequestErrors.VALIDATION_FAILED, {
      message: field === 'phone' ? 'Phone number is required.' : 'Email is required.',
      details: [{ field, message: field === 'phone' ? 'Phone number is required.' : 'Email is required.' }],
    });
  }
  return { channel: dto.channel, recipient };
}
