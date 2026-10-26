import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import type Redis from 'ioredis';
import type { Connection } from 'mongoose';
import { Role } from '@/common/auth/auth.types';
import { REDIS_CACHE, REDIS_CORE } from '@/infra/redis/redis.constants';

export const tokenFor = (userId: string, role: Role = Role.USER): string =>
  new JwtService().sign({ sub: userId, role }, { secret: process.env.JWT_ACCESS_SECRET!, expiresIn: '10m' });

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Drops the e2e database and every Redis key under the e2e prefix. */
export async function resetState(app: INestApplication): Promise<void> {
  await app.get<Connection>(getConnectionToken()).dropDatabase();
  for (const token of [REDIS_CORE, REDIS_CACHE]) {
    const redis = app.get<Redis>(token);
    const keys = await redis.keys(`${process.env.REDIS_KEY_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  }
}

/** Waits for fire-and-forget writes (audit log) to land. */
export async function eventually<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
