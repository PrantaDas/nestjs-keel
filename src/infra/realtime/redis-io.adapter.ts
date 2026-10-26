import { INestApplication, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import type { Namespace, Server, ServerOptions, Socket } from 'socket.io';
import { appConfig, redisConfig, runtimeConfig, socketConfig } from '@/config/configuration';
import { closeRedis, waitForReady } from '@/infra/redis/redis-client.factory';
import { type AdapterClients, createAdapterClients, guardPublishes } from './adapter-clients';
import { socketAdapterOptions } from './realtime.constants';
import { SocketAuthMiddleware } from './socket-auth.middleware';
import { createSocketRateLimiter } from './socket-rate-limiter';

/**
 * Socket.IO tuned for mobile networks and horizontal scaling:
 * websocket-only (no polling, no sticky sessions), sharded Redis adapter with per-room
 * subscriptions, compression above a size threshold, JWT handshake auth, per-socket rate limit.
 *
 * Redis outages (docs/architecture/fault-tolerance.md): the process boots and keeps serving without the core
 * Redis. Sockets stay connected and broadcasts reach this instance's own sockets; cross-instance
 * delivery pauses (logged) and resumes by itself once Redis is back (subscriptions are replayed).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly adapterLogger = new Logger(RedisIoAdapter.name);
  private clients?: AdapterClients;

  constructor(private readonly app: INestApplication) {
    super(app);
  }

  /** Creates the adapter's Redis clients; waits for them up to the connect timeout, never fails. */
  async connectToRedis(): Promise<void> {
    const { url } = this.app.get<ConfigType<typeof redisConfig>>(redisConfig.KEY);
    const { redis } = this.app.get<ConfigType<typeof runtimeConfig>>(runtimeConfig.KEY);
    this.clients = createAdapterClients('socket', url, redis);
    const ready = await Promise.all([
      waitForReady(this.clients.pub, redis.connectTimeoutMs),
      waitForReady(this.clients.sub, redis.connectTimeoutMs),
    ]);
    if (!ready.every(Boolean)) {
      this.adapterLogger.warn('Socket adapter Redis unreachable: serving local sockets only until it is back');
    }
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const socket = this.app.get<ConfigType<typeof socketConfig>>(socketConfig.KEY);
    const app = this.app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    const { keyPrefix } = this.app.get<ConfigType<typeof redisConfig>>(redisConfig.KEY);
    if (!this.clients) throw new Error('RedisIoAdapter.connectToRedis() must run first');

    const server = super.createIOServer(port, {
      ...options,
      path: socket.path,
      transports: ['websocket'],
      pingInterval: socket.pingIntervalMs,
      pingTimeout: socket.pingTimeoutMs,
      maxHttpBufferSize: socket.maxBufferBytes,
      perMessageDeflate: { threshold: socket.compressionThresholdBytes },
      cors: {
        origin: app.corsOrigins.length ? app.corsOrigins : false,
        credentials: true,
      },
      adapter: createShardedAdapter(this.clients.pub, this.clients.sub, socketAdapterOptions(keyPrefix)),
    } as ServerOptions);
    guardPublishes(server, 'socket');
    return server;
  }

  override create(port: number, options?: ServerOptions & { namespace?: string; server?: Server }): Server {
    const target = super.create(port, options);
    target.use(this.app.get(SocketAuthMiddleware).use);
    return target as Server;
  }

  override bindClientConnect(server: Server | Namespace, callback: (socket: Socket) => void): void {
    const { eventsPerWindow, eventWindowMs } = this.app.get<ConfigType<typeof socketConfig>>(socketConfig.KEY);
    server.on('connection', (socket: Socket) => {
      socket.use(createSocketRateLimiter(socket, eventsPerWindow, eventWindowMs));
      callback(socket);
    });
  }

  /**
   * Shutdown (after the HTTP drain): every socket's transport is closed, so clients see
   * `transport close` and reconnect on their own, to another instance behind the load balancer.
   */
  override async close(server: Server): Promise<void> {
    await super.close(server);
    if (this.clients) await Promise.allSettled([closeRedis(this.clients.pub), closeRedis(this.clients.sub)]);
  }
}
