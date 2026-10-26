import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/infra/database/base.schema';

export type AuditOutcome = 'success' | 'failure';

@Schema({ ...baseSchemaOptions, collection: 'audit_logs', timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ required: true })
  actorId: string;

  @Prop({ required: true })
  actorRole: string;

  /** Dotted verb, e.g. `user.disable`; defaults to `METHOD /route`. */
  @Prop({ required: true })
  action: string;

  @Prop()
  resource?: string;

  @Prop()
  resourceId?: string;

  @Prop({ required: true })
  method: string;

  /** Route pattern (`/api/v1/admin/users/:id`), groups well in queries. */
  @Prop({ required: true })
  route: string;

  /** Concrete URL that was called. */
  @Prop({ required: true })
  url: string;

  @Prop({ required: true })
  statusCode: number;

  @Prop({ type: String, required: true, enum: ['success', 'failure'] })
  outcome: AuditOutcome;

  @Prop()
  errorCode?: number;

  @Prop({ type: MongooseSchema.Types.Mixed })
  params?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  query?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  body?: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed })
  before?: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed })
  after?: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, unknown>;

  @Prop()
  ip?: string;

  @Prop()
  userAgent?: string;

  @Prop()
  requestId?: string;

  @Prop()
  durationMs?: number;

  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ actorId: 1, createdAt: -1 });
AuditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
// The TTL index on createdAt is added in AuditModule, where the retention setting is available.
