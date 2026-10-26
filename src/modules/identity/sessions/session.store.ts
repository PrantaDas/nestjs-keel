import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Role } from '@/common/auth/auth.types';
import { TimeService } from '@/common/time/time.service';
import { redisConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';

/** One signed-in device. Lives in the core Redis; deleting it signs that device out at once. */
export interface SessionRecord {
  id: string;
  userId: string;
  role: Role;
  /** jti of the only refresh token this session accepts (rotated on every refresh). */
  jti: string;
  /** What the person sees in "where you're signed in" ("iPhone 15", or the user agent). */
  device: string;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export type RotateOutcome =
  | { status: 'rotated'; session: SessionRecord }
  /** The token was already rotated: someone holds a stolen copy. The session (family) is now revoked. */
  | { status: 'reused' }
  | { status: 'missing' };

/*
 * Atomic refresh-token rotation. KEYS: session hash, user index. ARGV: presented jti, new jti,
 * ttl ms, now (ISO), expiresAt (ISO), session id, user id.
 * - no session (or another user's) → 'missing' (expired or revoked)
 * - jti differs     → the presented token was rotated before: delete the session → 'reused'
 * - jti matches     → store the new jti, extend the TTL → 'rotated'
 */
const ROTATE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'uid') ~= ARGV[7] then return 'missing' end
if redis.call('HGET', KEYS[1], 'jti') ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[6])
  return 'reused'
end
redis.call('HSET', KEYS[1], 'jti', ARGV[2], 'lastUsedAt', ARGV[4], 'expiresAt', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 'rotated'
`;

const SET_ROLE_SCRIPT = `if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'role', ARGV[1]) end return 1`;

/**
 * Sessions in the core Redis (`noeviction`): `session:<id>` (hash, TTL = refresh lifetime, slid on
 * every refresh) and `user-sessions:<userId>` (sorted set of session ids by creation, for "sign out
 * everywhere", the device list and the per-user limit). Every access-token check reads the session,
 * so revocation takes effect immediately, not when the access token expires.
 */
@Injectable()
export class SessionStore {
  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    private readonly time: TimeService,
  ) {}

  async create(input: {
    userId: string;
    role: Role;
    jti: string;
    device: string;
    ip: string | null;
    ttlSeconds: number;
  }): Promise<SessionRecord> {
    const now = this.time.now();
    const session: SessionRecord = {
      id: randomUUID().replaceAll('-', ''),
      userId: input.userId,
      role: input.role,
      jti: input.jti,
      device: input.device.slice(0, 200),
      ip: input.ip,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: this.time.after(input.ttlSeconds * 1000, now),
    };
    await this.redis
      .multi()
      .hset(this.key(session.id), serialize(session))
      .pexpire(this.key(session.id), input.ttlSeconds * 1000)
      .zadd(this.userKey(input.userId), now.getTime(), session.id)
      .pexpire(this.userKey(input.userId), input.ttlSeconds * 1000)
      .exec();
    return session;
  }

  /** A pre-generated jti is handed in so the refresh token can be signed before the session exists. */
  newJti(): string {
    return randomUUID();
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.hgetall(this.key(sessionId));
    return raw.uid ? deserialize(sessionId, raw) : null;
  }

  /** `userId` and `presentedJti` come from a verified refresh token. */
  async rotate(
    userId: string,
    sessionId: string,
    presentedJti: string,
    nextJti: string,
    ttlSeconds: number,
  ): Promise<RotateOutcome> {
    const now = this.time.now();
    const reply = (await this.redis.eval(
      ROTATE_SCRIPT,
      2,
      this.key(sessionId),
      this.userKey(userId),
      presentedJti,
      nextJti,
      ttlSeconds * 1000,
      now.toISOString(),
      this.time.after(ttlSeconds * 1000, now).toISOString(),
      sessionId,
      userId,
    )) as 'missing' | 'reused' | 'rotated';
    if (reply !== 'rotated') return { status: reply };
    const session = await this.get(sessionId);
    return session ? { status: 'rotated', session } : { status: 'missing' };
  }

  /** Every live session of a user, newest first; ids whose session expired are pruned on the way. */
  async list(userId: string): Promise<SessionRecord[]> {
    const ids = await this.redis.zrevrange(this.userKey(userId), 0, -1);
    const sessions = await Promise.all(ids.map((id) => this.get(id)));
    const dead = ids.filter((_, index) => !sessions[index]);
    if (dead.length) await this.redis.zrem(this.userKey(userId), ...dead);
    return sessions.filter((session): session is SessionRecord => session !== null && session.userId === userId);
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const [[, deleted]] = (await this.redis
      .multi()
      .del(this.key(sessionId))
      .zrem(this.userKey(userId), sessionId)
      .exec()) as [[unknown, number], [unknown, number]];
    return deleted === 1;
  }

  /** Revokes every session of the user (optionally keeping one) and returns the revoked ids. */
  async revokeAll(userId: string, keep?: string): Promise<string[]> {
    const ids = (await this.redis.zrange(this.userKey(userId), '0', '-1')).filter((id) => id !== keep);
    if (!ids.length) return [];
    await this.redis
      .multi()
      .del(...ids.map((id) => this.key(id)))
      .zrem(this.userKey(userId), ...ids)
      .exec();
    return ids;
  }

  /** Revokes the oldest sessions beyond `max` (a new sign-in pushes the oldest device out). */
  async enforceLimit(userId: string, max: number): Promise<string[]> {
    const count = await this.redis.zcard(this.userKey(userId));
    if (count <= max) return [];
    const oldest = await this.redis.zrange(this.userKey(userId), '0', String(count - max - 1));
    await Promise.all(oldest.map((id) => this.revoke(userId, id)));
    return oldest;
  }

  /** A role change applies to live sessions at once (the guard reads the role from the session). */
  async setRole(userId: string, role: Role): Promise<void> {
    const ids = await this.redis.zrange(this.userKey(userId), '0', '-1');
    if (!ids.length) return;
    const pipeline = this.redis.pipeline();
    // Only sessions that still exist: HSET on a missing key would recreate it without a TTL.
    for (const id of ids) pipeline.eval(SET_ROLE_SCRIPT, 1, this.key(id), role);
    await pipeline.exec();
  }

  private key(sessionId: string): string {
    return `${this.config.keyPrefix}session:${sessionId}`;
  }

  private userKey(userId: string): string {
    return `${this.config.keyPrefix}user-sessions:${userId}`;
  }
}

function serialize(session: SessionRecord): Record<string, string> {
  return {
    uid: session.userId,
    role: session.role,
    jti: session.jti,
    device: session.device,
    ip: session.ip ?? '',
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

function deserialize(id: string, raw: Record<string, string>): SessionRecord {
  return {
    id,
    userId: raw.uid,
    role: raw.role as Role,
    jti: raw.jti,
    device: raw.device,
    ip: raw.ip || null,
    createdAt: new Date(raw.createdAt),
    lastUsedAt: new Date(raw.lastUsedAt),
    expiresAt: new Date(raw.expiresAt),
  };
}
