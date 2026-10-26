import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { redisConfig, runtimeConfig } from '@/config/configuration';
import { RateGate } from '@/common/utils/rate-gate';
import { closeRedis } from '@/infra/redis/redis-client.factory';
import { type AdapterClients, createAdapterClients, guardPublishes } from './adapter-clients';
import { Rooms, socketAdapterOptions } from './realtime.constants';

/**
 * Publishes socket events and socket commands from any process (api, worker, cron, socket). It
 * runs a headless Socket.IO server (no HTTP, no clients) on the same sharded Redis adapter, so a
 * broadcast here reaches clients connected to any socket instance.
 *
 * Commands (`socketsLeave`, `disconnect*`) use the adapter's cluster messages: each one is
 * published once on the namespace channel and every socket instance applies it to its own
 * sockets, so they work from processes without clients too. They address rooms, never socket ids,
 * and need no reply (no `fetchSockets` round trip, no wait on slow instances).
 *
 * All methods are fire-and-forget and best-effort: they return at once, never throw and never
 * fail the request or job that calls them. A message that cannot reach Redis (outage: it waits up to
 * the command timeout) is dropped and logged; clients re-sync on reconnect.
 * Services depend on this class, never on Socket.IO directly, so the transport can change.
 */
@Injectable()
export class RealtimeEmitter implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private readonly failureLogs = new RateGate(30_000);
  private io?: Server;
  private clients?: AdapterClients;

  constructor(
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    @Inject(runtimeConfig.KEY) private readonly resilience: ConfigType<typeof runtimeConfig>,
  ) {}

  onModuleInit(): void {
    this.clients = createAdapterClients('emitter', this.config.url, this.resilience.redis);
    this.io = new Server({
      adapter: createShardedAdapter(this.clients.pub, this.clients.sub, socketAdapterOptions(this.config.keyPrefix)),
    });
    guardPublishes(this.io, 'emitter');
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.toRoom(Rooms.user(userId), event, payload);
  }

  toRoom(room: string, event: string, payload: unknown): void {
    this.send('event', { room, event }, (io) => io.to(room).emit(event, payload));
  }

  toAll(event: string, payload: unknown): void {
    this.send('broadcast', { event }, (io) => io.emit(event, payload));
  }

  /**
   * Makes every socket in `room`, on every instance, leave `targetRoom` (one room or several),
   * e.g. a banned player's `user:<id>` sockets leaving a game's rooms at once.
   */
  socketsLeave(room: string, targetRoom: string | readonly string[]): void {
    const targets = typeof targetRoom === 'string' ? [targetRoom] : [...targetRoom];
    if (targets.length) this.send('socketsLeave', { room, targets }, (io) => io.in(room).socketsLeave(targets));
  }

  /** Closes every socket of the user on every instance (account deleted or disabled, sign-out everywhere). */
  disconnectUser(userId: string): void {
    this.disconnectRooms([Rooms.user(userId)]);
  }

  /**
   * Closes the sockets opened with this session's access tokens (session revoked). Sockets
   * authenticated without a session id (dev tokens outside production) are only reachable by
   * `disconnectUser`.
   */
  disconnectSession(sessionId: string): void {
    this.disconnectSessions([sessionId]);
  }

  /** `disconnectSession` for several sessions in one adapter message. */
  disconnectSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length) this.disconnectRooms(sessionIds.map((id) => Rooms.session(id)));
  }

  async onApplicationShutdown(): Promise<void> {
    // Headless server has no engine, so `io.close()` would throw; unsubscribe the adapter instead.
    await Promise.allSettled([this.io?.of('/').adapter.close()]);
    if (this.clients) await Promise.allSettled([closeRedis(this.clients.pub), closeRedis(this.clients.sub)]);
  }

  /**
   * `close: true` also closes the underlying connection, so the server never relies on the client
   * to hang up. A client that reconnects goes through the handshake again, which refuses revoked
   * sessions (`connect_error` with `SESSION_REVOKED`).
   */
  private disconnectRooms(rooms: string[]): void {
    this.send('disconnect', { rooms }, (io) => io.in(rooms).disconnectSockets(true));
  }

  /** Runs one emit; whatever goes wrong is logged (at most every 30 s per action), never thrown. */
  private send(action: string, context: Record<string, unknown>, emit: (io: Server) => unknown): void {
    if (!this.io) {
      this.logger.warn({ action, ...context }, 'Emitter not ready, dropped');
      return;
    }
    try {
      emit(this.io);
    } catch (err) {
      const gate = this.failureLogs.pass(action);
      if (gate.pass) this.logger.warn({ err, action, ...context, suppressed: gate.suppressed }, 'Socket emit failed');
    }
  }
}
