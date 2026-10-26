import { ApiProperty, SchemaObject } from '@nestjs/swagger';
import { ApiDateTimeProperty, ApiMapProperty } from '@/common/swagger';

/** Swagger documentation types for the health routes (runtime shapes come from the handlers). */

export class LivenessResponse {
  @ApiProperty({ type: String, enum: ['ok'] })
  status: 'ok';

  @ApiProperty({ type: Number, example: 86400 })
  uptimeSeconds: number;

  @ApiDateTimeProperty({ description: 'Server clock; apps sync countdowns to it' })
  serverTime: string;
}

const DEPENDENCY_CHECK: SchemaObject = {
  type: 'object',
  required: ['status', 'required'],
  properties: {
    status: { type: 'string', enum: ['up', 'down'] },
    required: { type: 'boolean', description: 'False for optional dependencies (the cache): down = degraded' },
    message: { type: 'string' },
  },
};

export class ReadinessResponse {
  @ApiProperty({
    type: String,
    enum: ['ok', 'degraded'],
    description: '`degraded`: serving, but an optional dependency (cache Redis) is down',
  })
  status: 'ok' | 'degraded';

  @ApiMapProperty(DEPENDENCY_CHECK, { description: 'Every dependency (`mongodb`, `redisCore`, `redisCache`)' })
  details: Record<string, unknown>;
}
