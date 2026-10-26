/**
 * Socket.IO Redis adapter options; must match on every process that publishes or receives socket
 * broadcasts and commands. The channel prefix derives from `REDIS_KEY_PREFIX` (default `app:` →
 * `app:socket`), so environments or test runs that share a Redis never see each other's events.
 */
export const socketAdapterOptions = (keyPrefix: string) =>
  ({
    channelPrefix: `${keyPrefix}socket`,
    subscriptionMode: 'dynamic',
  }) as const;

/** Rooms every socket joins at connection (`BaseGateway`). */
export const Rooms = {
  /** Every device of the user: `RealtimeEmitter.toUser` / `disconnectUser`. */
  user: (userId: string): string => `user:${userId}`,
  /** The sockets opened with one session's access tokens: `RealtimeEmitter.disconnectSession`. */
  session: (sessionId: string): string => `session:${sessionId}`,
};

/** Event a client receives when an event handler fails and no ack callback was given. */
export const SOCKET_ERROR_EVENT = 'exception';
