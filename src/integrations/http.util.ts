import { classifyFailure, classifyHttpStatus, IntegrationCallException, redactSecrets } from './resilience/failure';
import { guardedCall } from './resilience/guarded-call';
import { defaultHttpTimeoutMs } from './resilience/settings';

/**
 * `fetch` with a timeout and JSON parsing for third-party REST APIs, through the integration's
 * circuit breaker (`breakerKey(integration)`). Any network error, timeout or non-2xx response
 * becomes a classified IntegrationCallException (502; transient for timeouts/network/429/5xx,
 * permanent for other 4xx); an open circuit fails fast with IntegrationUnavailableException (503).
 * Never retried here: callers decide (jobs retry behind a claim, idempotent reads may retry).
 */
export async function fetchJson<T>(
  integration: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = defaultHttpTimeoutMs(),
): Promise<T> {
  return guardedCall(integration, async () => {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new IntegrationCallException(integration, classifyFailure(error), error);
    }

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      // Body cut off (timeout / reset) after the status line: a 2xx may already have been acted on.
      if (response.ok) throw new IntegrationCallException(integration, classifyFailure(error), error);
    }
    if (!response.ok) {
      throw new IntegrationCallException(
        integration,
        classifyHttpStatus(response.status),
        new Error(`HTTP ${response.status}: ${redactSecrets(text)}`),
      );
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      // The provider answered 2xx with something that is not JSON: it may have acted on it.
      throw new IntegrationCallException(integration, { transient: true, ambiguous: true, reason: 'bad_json' }, error);
    }
  });
}

/** Decodes a base64-encoded JSON value from env; undefined when not set. */
export function decodeBase64Json<T>(value: string): T | undefined {
  if (!value) return undefined;
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
}
