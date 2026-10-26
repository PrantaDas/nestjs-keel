import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Namespace, Server } from 'socket.io';
import { RateGate } from '@/common/utils/rate-gate';
import { createRedisClient, redisOptions, type RedisSettings } from '@/infra/redis/redis-client.factory';

export interface AdapterClients {
  pub: Redis;
  sub: Redis;
}

const SUBSCRIPTION_COMMANDS = ['ssubscribe', 'sunsubscribe', 'subscribe', 'unsubscribe'] as const;

/**
 * Redis clients for the sharded Socket.IO adapter (socket process) or the headless emitter (every
 * process). The subscriber queues subscriptions until Redis is back (and ioredis re-subscribes every
 * channel after a reconnect); the publisher fails a broadcast after the command timeout.
 */
export function createAdapterClients(name: string, url: string, settings: RedisSettings): AdapterClients {
  const pub = createRedisClient(`${name}-pub`, url, redisOptions('publisher', settings));
  const sub = createRedisClient(`${name}-sub`, url, redisOptions('subscriber', settings));
  guardSubscriptions(sub, new Logger(`Redis:${name}-sub`));
  return { pub, sub };
}

/**
 * The adapter (and ioredis' own re-subscribe after a reconnect) fire SSUBSCRIBE / SUNSUBSCRIBE
 * without awaiting them. A rejected one would be an unhandled rejection, which ends the process:
 * every such promise gets a handler that logs the failure instead.
 */
export function guardSubscriptions(client: Redis, logger: Logger): void {
  const gate = new RateGate(30_000);
  const target = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const command of SUBSCRIPTION_COMMANDS) {
    const original = target[command].bind(client);
    target[command] = (...args: unknown[]) => {
      const promise = original(...args);
      promise.catch((err: unknown) => {
        const pass = gate.pass(command);
        if (pass.pass) logger.warn({ err, command, suppressed: pass.suppressed }, 'Socket adapter subscription failed');
      });
      return promise;
    };
  }
}

interface PublishingAdapter {
  doPublish(message: unknown): Promise<string>;
  doPublishResponse(requesterUid: string, response: unknown): Promise<void>;
  __appGuarded?: boolean;
}

/**
 * Socket.IO's cluster adapter drops a broadcast entirely (local sockets included) when publishing
 * to Redis fails, and only reports it to `debug`. Wrapped here: the failure is logged (at most every
 * 30 s) and the broadcast still reaches this instance's own sockets; other instances miss it until
 * Redis is back. Applies to every namespace, present and future.
 */
export function guardPublishes(server: Server, label: string): void {
  const logger = new Logger(`Realtime:${label}`);
  const gate = new RateGate(30_000);
  const guard = (namespace: Namespace) => {
    const adapter = namespace.adapter as unknown as PublishingAdapter;
    if (adapter.__appGuarded || typeof adapter.doPublish !== 'function') return;
    adapter.__appGuarded = true;
    const publish = adapter.doPublish.bind(adapter);
    const report = (err: unknown) => {
      const pass = gate.pass('publish');
      if (pass.pass) {
        logger.warn(
          { err, namespace: namespace.name, dropped: pass.suppressed + 1 },
          'Socket broadcast not published to other instances: Redis unavailable (local sockets still served)',
        );
      }
    };
    adapter.doPublish = (message) =>
      publish(message).catch((err: unknown) => {
        report(err);
        return '';
      });
    if (typeof adapter.doPublishResponse === 'function') {
      const respond = adapter.doPublishResponse.bind(adapter);
      adapter.doPublishResponse = (requesterUid, response) =>
        respond(requesterUid, response).catch((err: unknown) => report(err));
    }
  };
  guard(server.of('/'));
  server.on('new_namespace', guard);
}
