import { SetMetadata } from '@nestjs/common';

export const DEPRECATED_KEY = 'api:deprecated';

export interface DeprecationOptions {
  /** Day the route stops answering (ISO date, UTC midnight), e.g. `2027-06-30`. After it: 410 ENDPOINT_RETIRED. */
  sunset: string;
  /** The route that replaces it, sent as `Link: <…>; rel="successor-version"`. */
  successor?: string;
  /** Since when it is deprecated (defaults to the decoration's sunset minus nothing: "now"). */
  since?: string;
}

/**
 * Marks a route (or controller) as deprecated: every answer carries `Deprecation` (RFC 9745),
 * `Sunset` (RFC 8594) and, when given, a successor `Link`; after the sunset day it answers 410.
 * Policy and the client contract: docs/conventions/versioning.md.
 */
export const Deprecated = (options: DeprecationOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(DEPRECATED_KEY, options);
