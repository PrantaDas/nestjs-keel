/** Owned by the notifications module: the push device tokens of an account. */

export type DevicePlatform = 'ios' | 'android' | 'web';

export interface DeviceRegistration {
  token: string;
  platform: DevicePlatform;
  appVersion?: string;
  /** Sign-in session that registered it: signing that session out removes the token. */
  sessionId?: string;
}

export abstract class DeviceRegistry {
  /** Registers or refreshes a token (last seen = now). A token moves to the latest account that registers it. */
  abstract register(userId: string, device: DeviceRegistration): Promise<void>;

  /** Removes the tokens registered by these sessions (sign-out). */
  abstract removeForSessions(userId: string, sessionIds: readonly string[]): Promise<void>;

  /** Removes every token of the account and unsubscribes them from topics (deactivation, deletion). */
  abstract removeAllForUser(userId: string): Promise<void>;
}
