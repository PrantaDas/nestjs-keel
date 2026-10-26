import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Types } from 'mongoose';
import { ApiDateTimeProperty, ApiFreeFormProperty, ApiObjectIdProperty } from '@/common/swagger';
import type { LeanDoc } from '@/infra/database/base.repository';
import type { AuditLog, AuditOutcome } from '../schemas/audit-log.schema';

export class AuditLogResponse implements LeanDoc<AuditLog> {
  @ApiObjectIdProperty()
  _id: Types.ObjectId;

  @ApiProperty({ type: String })
  actorId: string;

  @ApiProperty({ type: String, example: 'super_admin' })
  actorRole: string;

  @ApiProperty({ type: String, example: 'user.disable', description: 'Dotted verb; defaults to `METHOD /route`' })
  action: string;

  @ApiPropertyOptional({ type: String, example: 'user' })
  resource?: string;

  @ApiPropertyOptional({ type: String })
  resourceId?: string;

  @ApiProperty({ type: String, example: 'PATCH' })
  method: string;

  @ApiProperty({ type: String, example: '/api/v1/admin/users/:id', description: 'Route pattern' })
  route: string;

  @ApiProperty({ type: String, description: 'Concrete URL that was called' })
  url: string;

  @ApiProperty({ type: Number, example: 200 })
  statusCode: number;

  @ApiProperty({ type: String, enum: ['success', 'failure'] })
  outcome: AuditOutcome;

  @ApiPropertyOptional({ type: Number, description: 'Error code when the call failed' })
  errorCode?: number;

  @ApiFreeFormProperty({ required: false, description: 'Route params' })
  params?: Record<string, unknown>;

  @ApiFreeFormProperty({ required: false, description: 'Query string' })
  query?: Record<string, unknown>;

  @ApiFreeFormProperty({ required: false, description: 'Request body (sanitised)' })
  body?: unknown;

  @ApiFreeFormProperty({ required: false, description: 'State before the change, when the service recorded it' })
  before?: unknown;

  @ApiFreeFormProperty({ required: false, description: 'State after the change, when the service recorded it' })
  after?: unknown;

  @ApiFreeFormProperty({ required: false })
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ type: String })
  ip?: string;

  @ApiPropertyOptional({ type: String })
  userAgent?: string;

  @ApiPropertyOptional({ type: String })
  requestId?: string;

  @ApiPropertyOptional({ type: Number })
  durationMs?: number;

  @ApiDateTimeProperty()
  createdAt: Date;
}
