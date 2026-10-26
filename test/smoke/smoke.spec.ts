import { JwtService } from '@nestjs/jwt';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { io, type Socket } from 'socket.io-client';

/**
 * Smoke test against RUNNING services (local `pnpm dev:*`, staging or production). Read-only: it
 * creates nothing, so it is safe to run against production after a deploy.
 *
 *   SMOKE_API_URL     default http://localhost:4000
 *   SMOKE_SOCKET_URL  default http://localhost:4001
 *   SMOKE_USER_TOKEN / SMOKE_ADMIN_TOKEN  bearer tokens; when absent they are minted from
 *                     JWT_ACCESS_SECRET (local only).
 *
 * Verifies every run mode: api and socket answer and are ready, the socket gateway authenticates
 * and answers events with the envelope, all four processes (api, socket, worker, cron) report a
 * heartbeat, and every background queue has a worker listening.
 */
// Jest sandboxes process.env, so parse .env into it directly (real env vars win).
if (existsSync('.env')) process.env = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };

const API = process.env.SMOKE_API_URL ?? 'http://localhost:4000';
const SOCKET = process.env.SMOKE_SOCKET_URL ?? 'http://localhost:4001';
const USER_ID = '64b0000000000000000000f1';
const MISSING_SESSION = '64b0000000000000000000f9';

const mint = (sub: string, role: string) =>
  new JwtService().sign({ sub, role }, { secret: process.env.JWT_ACCESS_SECRET!, expiresIn: '10m' });
const userToken = process.env.SMOKE_USER_TOKEN ?? mint(USER_ID, 'user');
const adminToken = process.env.SMOKE_ADMIN_TOKEN ?? mint('64b0000000000000000000a1', 'super_admin');

const api = (path: string, token = adminToken) =>
  fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });

const connect = (token?: string): Socket =>
  io(SOCKET, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });

const connected = (socket: Socket) =>
  new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });

describe('smoke', () => {
  const sockets: Socket[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  it.each([
    ['api', API],
    ['socket', SOCKET],
  ])('%s process is alive and ready', async (_name, base) => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${base}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('rejects a socket handshake without a token, with the error envelope', async () => {
    const socket = connect();
    sockets.push(socket);
    const error = await new Promise<Error & { data?: unknown }>((resolve) => socket.on('connect_error', resolve));
    expect(error.data).toMatchObject({ success: false, errorCode: 1000, error: 'MISSING_BEARER_TOKEN' });
  });

  it('answers authenticated socket events with the envelope (domain error and validation)', async () => {
    const socket = connect(userToken);
    sockets.push(socket);
    await connected(socket);

    const missing = await socket.timeout(5000).emitWithAck('live-quiz:join', { sessionId: MISSING_SESSION });
    expect(missing).toMatchObject({ success: false, errorCode: 5040, error: 'SESSION_NOT_FOUND' });

    const invalid = await socket.timeout(5000).emitWithAck('live-quiz:join', { sessionId: 'not-an-id' });
    expect(invalid).toMatchObject({ success: false });
    expect(['VALIDATION_FAILED', 'INVALID_ID']).toContain((invalid as { error: string }).error);
  });

  it('sees a heartbeat from every run mode (api, socket, worker, cron)', async () => {
    const res = await api('/api/v6/admin/ops/processes');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { mode: string }[] };
    expect(new Set(data.map((p) => p.mode))).toEqual(new Set(['api', 'socket', 'worker', 'cron']));
  });

  it('has a worker listening on every background queue', async () => {
    const res = await api('/api/v6/admin/ops/queues');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; workers: number | null }[] };
    expect(data.length).toBeGreaterThan(0);
    // null: the Redis plan does not allow counting connections; the heartbeat check covers it.
    const idle = data.filter((q) => q.workers === 0).map((q) => q.name);
    expect(idle).toEqual([]);
  });
});
