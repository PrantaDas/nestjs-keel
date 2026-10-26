import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { GraphQLFormattedError } from 'graphql';
import { RequestContext } from '@/common/context/request-context';
import { mapException } from '@/common/exceptions/exception-mapper';

const logger = new Logger('GraphQL');

/** What a client finds in `errors[].extensions`: the REST error envelope minus `success`. */
export interface GraphqlErrorExtensions {
  /** Same stable key as REST (`NOTE_NOT_FOUND`), so clients branch the same way. */
  code: string;
  errorCode: number;
  details?: unknown;
  requestId?: string;
}

/**
 * GraphQL errors carry the same contract as REST (docs/conventions/errors.md "GraphQL"):
 * `message` is the human `errorMessage`, `extensions` holds `code` (the error key), `errorCode`,
 * `details` and `requestId`. Anything the app threw goes through the same mapper as REST, so
 * internals never leak; GraphQL's own errors (syntax, unknown field, depth / complexity limits)
 * are about the query, not the person, and keep their message with Apollo's code.
 */
export function formatGraphqlError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original = (error as { originalError?: unknown } | undefined)?.originalError;
  const requestId = RequestContext.requestId();
  if (!original) {
    return {
      message: formatted.message,
      locations: formatted.locations,
      path: formatted.path,
      extensions: { code: formatted.extensions?.code ?? 'GRAPHQL_ERROR', requestId },
    };
  }
  const { body, isServerError, dependency } = mapException(original, requestId);
  if (dependency) logger.warn({ err: original, dependency }, `Dependency unavailable: ${body.error}`);
  else if (isServerError) {
    logger.error({ err: original, requestId, path: formatted.path }, `Unhandled GraphQL error: ${body.error}`);
    Sentry.withScope((scope) => {
      scope.setTag('requestId', requestId ?? 'none');
      Sentry.captureException(original);
    });
  }
  const extensions: GraphqlErrorExtensions = {
    code: body.error,
    errorCode: body.errorCode,
    ...(body.details ? { details: body.details } : {}),
    requestId,
  };
  return {
    message: body.errorMessage,
    path: formatted.path,
    locations: formatted.locations,
    extensions: { ...extensions },
  };
}
