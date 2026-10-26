import { Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '@/common/interceptors/response-envelope.interceptor';
import { createValidationPipe } from '@/common/pipes/validation.pipe';

/** Response envelope, error envelope and DTO validation for any process that serves HTTP. */
export const httpProviders: Provider[] = [
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  { provide: APP_PIPE, useFactory: createValidationPipe },
];
