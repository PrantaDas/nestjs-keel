import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/*
 * Documentation types for the shared HTTP envelopes. They mirror `SuccessEnvelope`
 * (response-envelope.interceptor.ts), `PaginationMeta` (pagination.dto.ts) and `ErrorEnvelope`
 * (exception-mapper.ts). Registered once as `components.schemas`; routes reference them.
 */

@ApiSchema({ name: 'SuccessEnvelope', description: 'Every 2xx JSON response. `data` is described per route.' })
export class SuccessEnvelopeModel {
  @ApiProperty({ type: Boolean, enum: [true], example: true })
  success: true;

  @ApiProperty({ type: String, example: 'Success', description: 'Human-readable message set by the route' })
  message: string;
}

@ApiSchema({ name: 'PaginationMeta', description: 'Page-based pagination (`?page=&limit=`).' })
export class PaginationMetaModel {
  @ApiProperty({ type: Number, minimum: 1, example: 1 })
  page: number;

  @ApiProperty({ type: Number, minimum: 1, example: 20 })
  limit: number;

  @ApiProperty({ type: Number, minimum: 0, example: 135 })
  totalDocs: number;

  @ApiProperty({ type: Number, minimum: 0, example: 7 })
  totalPages: number;

  @ApiProperty({ type: Boolean })
  hasNextPage: boolean;

  @ApiProperty({ type: Boolean })
  hasPrevPage: boolean;
}

@ApiSchema({ name: 'ErrorDetail', description: 'One field-level problem (validation errors, duplicate keys).' })
export class ErrorDetailModel {
  @ApiPropertyOptional({ type: String, example: 'email', description: 'Dotted path of the offending field' })
  field?: string;

  @ApiProperty({ type: String, example: 'email must be a valid email address' })
  message: string;
}

@ApiSchema({ name: 'ErrorEnvelope', description: 'Every error response, whatever the status.' })
export class ErrorEnvelopeModel {
  @ApiProperty({ type: Boolean, enum: [false], example: false })
  success: false;

  @ApiProperty({ type: Number, example: 2000, description: 'Stable numeric code (see the error catalogues)' })
  errorCode: number;

  @ApiProperty({ type: String, example: 'VALIDATION_FAILED', description: 'Stable machine-readable key' })
  error: string;

  @ApiProperty({ type: String, example: 'The request contains invalid data.', description: 'Safe to show to people' })
  errorMessage: string;

  @ApiPropertyOptional({ type: () => [ErrorDetailModel] })
  details?: ErrorDetailModel[];

  @ApiProperty({
    type: String,
    example: '3f1c2d9e-5b7a-4c1e-9f0a-2b6d8e4c7a10',
    description: 'Matches logs and Sentry',
  })
  requestId: string;
}

/** Registered as extra models so they always appear in `components.schemas`. */
export const ENVELOPE_MODELS = [SuccessEnvelopeModel, PaginationMetaModel, ErrorDetailModel, ErrorEnvelopeModel];
