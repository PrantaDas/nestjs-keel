import type { NextFunction, Request, Response } from 'express';
import { RequestErrors, RequestException } from '@/common/exceptions';

/**
 * Express error middleware placed right after the body parsers. Nest would otherwise turn
 * these into a generic 400 (or a 500 for an aborted upload), losing the reason; here they become
 * precise domain errors.
 */
export function bodyParserErrorMiddleware(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  const type = (err as { type?: string } | undefined)?.type;
  if (type === 'entity.parse.failed') return next(new RequestException(RequestErrors.MALFORMED_JSON));
  if (type === 'entity.too.large') return next(new RequestException(RequestErrors.PAYLOAD_TOO_LARGE));
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return next(new RequestException(RequestErrors.UNSUPPORTED_MEDIA_TYPE));
  }
  // The client hung up while sending the body: nobody reads the answer, so it is logged only.
  if (type === 'request.aborted') return next(new RequestException(RequestErrors.CLIENT_CLOSED_REQUEST));
  next(err);
}
