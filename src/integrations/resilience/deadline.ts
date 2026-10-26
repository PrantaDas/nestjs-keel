/** The SDK did not settle within its deadline; the call may still complete in the background. */
export class DeadlineExceededError extends Error {
  override readonly name = 'TimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`No answer within ${timeoutMs} ms`);
  }
}

/**
 * Releases the caller after `timeoutMs` for SDKs without a usable overall timeout (firebase-admin
 * retries internally, nodemailer pools). Rejects with DeadlineExceededError (classified as a
 * transient, ambiguous timeout). Prefer the SDK's own timeout where it cancels the request.
 */
export function withDeadline<T>(call: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return call;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}
