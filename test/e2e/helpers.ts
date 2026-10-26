import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { Connection } from 'mongoose';
import type request from 'supertest';
import { Role } from '@/common/auth/auth.types';
import { QueueName } from '@/infra/queue/queue.constants';
import { REDIS_CACHE, REDIS_CORE } from '@/infra/redis/redis.constants';
import type { OtpDeliveryJob } from '@/modules/identity/otp/otp.types';
import { UsersService } from '@/modules/identity/users/users.service';

export const API = '/api/v1';
export const PASSWORD = 'correct-horse-42';
/** Matches the digest in setup-env.ts API_KEYS. */
export const E2E_API_KEY = 'e2e-machine-key-0123456789';

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Drops the e2e database and every Redis key under the e2e prefix (queues included). */
export async function resetState(app: INestApplication): Promise<void> {
  await app.get<Connection>(getConnectionToken()).dropDatabase();
  for (const token of [REDIS_CORE, REDIS_CACHE]) {
    const redis = app.get<Redis | null>(token, { strict: false });
    if (!redis) continue;
    const keys = await redis.keys(`${process.env.REDIS_KEY_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  }
}

export interface SignedIn {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  auth: { Authorization: string };
}

let counter = 0;
/** A unique e-mail per call, so tests never collide inside one database. */
export const uniqueEmail = (label = 'user') => `${label}.${process.pid}.${(counter += 1)}@example.com`;

/** Signs up through the real route. */
export async function signUp(
  http: ReturnType<typeof request>,
  fields: Partial<{ name: string; email: string; password: string; device: object }> = {},
): Promise<SignedIn & { email: string }> {
  const email = fields.email ?? uniqueEmail();
  const res = await http
    .post(`${API}/auth/register`)
    .send({ name: fields.name ?? 'Test Person', email, password: fields.password ?? PASSWORD, device: fields.device })
    .expect(201);
  return { ...signedIn(res.body.data), email };
}

/** An account with a role, created through the service (there is no public route for staff), then signed in. */
export async function staffAccount(
  app: INestApplication,
  http: ReturnType<typeof request>,
  role: Role,
): Promise<SignedIn> {
  const email = uniqueEmail(role);
  await app.get(UsersService).create({ name: `${role} account`, email, password: PASSWORD, role, emailVerified: true });
  const res = await http.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
  return signedIn(res.body.data);
}

export function signedIn(data: {
  user: { _id: string };
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}): SignedIn {
  return {
    userId: data.user._id,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    sessionId: data.sessionId,
    auth: bearer(data.accessToken),
  };
}

/**
 * The last code queued for delivery to `recipient`, read from the real `otp-delivery` queue (the
 * worker is not running in e2e, so the job is still waiting there).
 */
export async function lastCodeFor(app: INestApplication, recipient: string): Promise<string> {
  const queue = app.get<Queue<OtpDeliveryJob>>(getQueueToken(QueueName.OTP_DELIVERY), { strict: false });
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'], 0, 200);
  const job = jobs
    .filter((j) => j.data.recipient === recipient)
    .sort((a, b) => b.timestamp - a.timestamp || Number(b.id?.split('-').pop()) - Number(a.id?.split('-').pop()))[0];
  if (!job) throw new Error(`No code queued for ${recipient}`);
  return job.data.code;
}

/** Waits for fire-and-forget writes (audit log) to land. Real time on purpose: it polls I/O. */
export async function eventually<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
