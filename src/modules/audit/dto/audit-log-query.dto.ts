import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsInstant } from '@/common/time/time.validators';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';

export class AuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by the admin who performed the action' })
  @IsOptional()
  @IsMongoId()
  actorId?: string;

  @ApiPropertyOptional({ example: 'user.disable' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ example: 'user' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  resource?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'From this instant (inclusive)' })
  @IsOptional()
  @IsInstant()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Until this instant (exclusive)' })
  @IsOptional()
  @IsInstant()
  to?: Date;
}
