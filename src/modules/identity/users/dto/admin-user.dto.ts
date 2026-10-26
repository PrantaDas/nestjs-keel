import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '@/common/auth/auth.types';
import type { AccountStatus } from '@/common/contracts/user-directory.contract';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';
import { IsInstant } from '@/common/time/time.validators';

const STATUSES: AccountStatus[] = ['active', 'deactivated', 'deletion_pending', 'deleted'];
export const USER_SORTS = ['createdAt', '-createdAt', 'name', '-name', 'lastLoginAt', '-lastLoginAt'] as const;
export type UserSort = (typeof USER_SORTS)[number];

export class AdminUserQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Prefix of the name or e-mail address' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: Role, enumName: 'Role' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ enum: STATUSES, enumName: 'AccountStatus', description: 'Default: everything but deleted' })
  @IsOptional()
  @IsIn(STATUSES)
  status?: AccountStatus;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Joined at or after this instant' })
  @IsOptional()
  @IsInstant()
  createdFrom?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Joined before this instant' })
  @IsOptional()
  @IsInstant()
  createdTo?: Date;

  @ApiPropertyOptional({ enum: USER_SORTS, default: '-createdAt' })
  @IsOptional()
  @IsIn(USER_SORTS)
  sort: UserSort = '-createdAt';
}

export class AdminUpdateUserDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: Role, enumName: 'Role', description: 'Super admins only' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
