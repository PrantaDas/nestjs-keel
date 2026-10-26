import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { DevicePlatform } from '@/common/contracts/device-registry.contract';
import { IsNormalizedEmail, IsPhone, IsStrongPassword } from '@/common/validation/contact.validators';

const PLATFORMS: DevicePlatform[] = ['ios', 'android', 'web'];
const CODE = /^\d{4,10}$/;
const CODE_MESSAGE = 'Code must be the digits from the message.';

/** The device signing in. With a push token it is registered for notifications in the same step. */
export class DeviceDto {
  @ApiPropertyOptional({ example: 'iPhone 15', description: 'Shown in "where you are signed in"' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ description: 'FCM registration token' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  pushToken?: string;

  @ApiPropertyOptional({ enum: PLATFORMS })
  @IsOptional()
  @IsIn(PLATFORMS)
  platform?: DevicePlatform;

  @ApiPropertyOptional({ example: '1.4.2' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

class WithDevice {
  @ApiPropertyOptional({ type: () => DeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;
}

export class RegisterDto extends WithDevice {
  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsNormalizedEmail()
  email: string;

  @ApiProperty({ minLength: 10, description: 'At least 10 characters, with a letter and a number' })
  @IsStrongPassword()
  password: string;
}

export class LoginDto extends WithDevice {
  @ApiProperty({ example: 'ada@example.com' })
  @IsNormalizedEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  refreshToken: string;
}

const CHANNELS = ['sms', 'email'] as const;
export type OtpChannelInput = (typeof CHANNELS)[number];

export class OtpRequestDto {
  @ApiProperty({ enum: CHANNELS, example: 'sms' })
  @IsIn(CHANNELS)
  channel: OtpChannelInput;

  @ApiPropertyOptional({ example: '+14155550123', description: 'Required for `sms`' })
  @IsOptional()
  @IsPhone()
  phone?: string;

  @ApiPropertyOptional({ example: 'ada@example.com', description: 'Required for `email`' })
  @IsOptional()
  @IsNormalizedEmail()
  email?: string;
}

export class OtpVerifyDto extends OtpRequestDto {
  @ApiProperty({ example: '123456' })
  @Matches(CODE, { message: CODE_MESSAGE })
  code: string;

  @ApiPropertyOptional({ type: () => DeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsNormalizedEmail()
  email: string;
}

export class ResetPasswordDto extends ForgotPasswordDto {
  @ApiProperty({ example: '123456' })
  @Matches(CODE, { message: CODE_MESSAGE })
  code: string;

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword: string;
}

export class VerifyEmailDto {
  @ApiProperty({ example: '123456' })
  @Matches(CODE, { message: CODE_MESSAGE })
  code: string;
}
