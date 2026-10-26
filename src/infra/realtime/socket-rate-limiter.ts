import type { Event, Socket } from 'socket.io';
import { RequestErrors } from '@/common/exceptions';
import { SOCKET_ERROR_EVENT } from './realtime.constants';

/**
 * Fixed-window event limiter per socket, kept in memory (no Redis round trip per event).
 * Over-limit events are dropped and the client is told once per window.
 */
export function createSocketRateLimiter(socket: Socket, limit: number, windowMs: number) {
  // Monotonic clock: immune to wall-clock jumps (NTP sync, manual changes).
  let windowStart = performance.now();
  let count = 0;
  let notified = false;

  return (_event: Event, next: (err?: Error) => void): void => {
    const now = performance.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
      notified = false;
    }

    count += 1;
    if (count <= limit) return next();

    if (!notified) {
      notified = true;
      socket.emit(SOCKET_ERROR_EVENT, {
        success: false,
        errorCode: RequestErrors.RATE_LIMITED.code,
        error: RequestErrors.RATE_LIMITED.key,
        errorMessage: RequestErrors.RATE_LIMITED.message,
      });
    }
  };
}
