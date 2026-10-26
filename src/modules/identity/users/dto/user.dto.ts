import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsTimeZone } from '@/common/time/time.validators';
import { IsNormalizedEmail, IsPhone, IsStrongPassword } from '@/common/validation/contact.validators';

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ada Lovelace', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'en-GB', description: 'BCP 47 language tag' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, { message: 'Language must be a code such as en or en-GB.' })
  locale?: string;

  @ApiPropertyOptional({ example: 'Europe/London', description: 'IANA zone, for display only' })
  @IsOptional()
  @IsTimeZone()
  timeZone?: string;
}

export class AvatarUploadDto {
  @ApiProperty({ enum: AVATAR_TYPES, example: 'image/png' })
  @IsIn(AVATAR_TYPES)
  contentType: AvatarType;

  @ApiProperty({ example: 120_000, description: 'Exact file size in bytes (signed into the upload URL)' })
  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024)
  sizeBytes: number;
}

export class ConfirmAvatarDto {
  @ApiProperty({ description: 'The `key` returned with the upload URL' })
  @IsString()
  @Matches(/^avatars\/[a-f0-9]{24}\/[a-f0-9-]{36}\.(png|jpg|webp)$/, {
    message: "This upload isn't valid. Please upload the picture again.",
  })
  key: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({ description: 'Required when the account already has a password' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @ApiProperty({ minLength: 10, description: 'At least 10 characters, with a letter and a number' })
  @IsStrongPassword()
  newPassword: string;
}

export class RequestEmailChangeDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsNormalizedEmail()
  email: string;
}

export class ConfirmEmailChangeDto extends RequestEmailChangeDto {
  @ApiProperty({ example: '123456' })
  @Matches(/^\d{4,10}$/, { message: 'Code must be the digits from the message.' })
  code: string;
}

export class RequestPhoneChangeDto {
  @ApiProperty({ example: '+14155550123' })
  @IsPhone()
  phone: string;
}

export class ConfirmPhoneChangeDto extends RequestPhoneChangeDto {
  @ApiProperty({ example: '123456' })
  @Matches(/^\d{4,10}$/, { message: 'Code must be the digits from the message.' })
  code: string;
}

export class ConfirmWithPasswordDto {
  @ApiPropertyOptional({ description: 'Required when the account has a password' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}
