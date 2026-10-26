import { Throttle } from '@nestjs/throttler';

/**
 * Per-route limits tighter than the global one, read when a request arrives (the values come from
 * config, set once by `SecurityModule`). Counted per route and per client (user when signed in,
 * else IP), within THROTTLE_TTL_SECONDS. Business limits that guard money or brute force (OTP sends
 * and checks per recipient) live in OtpService and fail closed; these fail open with the throttler.
 */
export const ThrottleLimits = {
  /** Sign-in, sign-up, refresh, password reset (THROTTLE_AUTH_LIMIT). */
  auth: 10,
  /** Routes that send a code (THROTTLE_OTP_LIMIT). */
  otp: 5,
};

export const AuthThrottle = (): MethodDecorator & ClassDecorator =>
  Throttle({ default: { limit: () => ThrottleLimits.auth } });

export const OtpThrottle = (): MethodDecorator & ClassDecorator =>
  Throttle({ default: { limit: () => ThrottleLimits.otp } });
