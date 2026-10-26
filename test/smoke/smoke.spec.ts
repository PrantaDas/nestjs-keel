import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { io, type Socket } from 'socket.io-client';

/**
 * Smoke test against RUNNING services (local, staging or production right after a deploy).
 * Read-only: it signs nobody in and writes nothing, so it is safe on production.
 *
 *   SMOKE_API_URL       default http://localhost:3000
 *   SMOKE_GRAPHQL_URL   default http://localhost:3002
 *   SMOKE_SOCKET_URL    default http://localhost:3001
 *   SMOKE_USER_TOKEN    access token of any account (locally: pnpm dev:token <userId>)
 *   SMOKE_ADMIN_TOKEN   access token of a super admin (ops endpoints)
 *   SMOKE_PROCESSES     processes that must report a heartbeat (default api,graphql,socket,worker,cron)
 *
 * Checks: every HTTP process is alive and ready; the socket handshake refuses a missing token with
 * the error envelope and answers an authenticated event; GraphQL answers an authenticated query;
 * every expected process reports a heartbeat; every background queue has a worker listening.
 */
// Jest sandboxes process.env, so parse .env into it directly (real env vars win).
if (existsSync('.env')) process.env = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3000';
const GRAPHQL = process.env.SMOKE_GRAPHQL_URL ?? 'http://localhost:3002';
const SOCKET = process.env.SMOKE_SOCKET_URL ?? 'http://localhost:3001';
const USER_TOKEN = process.env.SMOKE_USER_TOKEN ?? '';
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN ?? '';
const PROCESSES = (process.env.SMOKE_PROCESSES ?? 'api,graphql,socket,worker,cron').split(',').map((p) => p.trim());

const authed = (token: string) => (token ? it : it.skip);
const api = (path: string, token: string) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
const connect = (token?: string): Socket =>
  io(SOCKET, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });

describe('smoke', () => {
  const sockets: Socket[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  it.each([
    ['api', API],
    ['graphql', GRAPHQL],
    ['socket', SOCKET],
  ])('%s process is alive and ready', async (_name, base) => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const ready = await fetch(`${base}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      success: true,
      data: { status: expect.stringMatching(/^(ok|degraded)$/) },
    });
  });

  it('refuses a socket handshake without a token, with the error envelope', async () => {
    const socket = connect();
    sockets.push(socket);
    const error = await new Promise<Error & { data?: unknown }>((resolve) => socket.on('connect_error', resolve));
    expect(error.data).toMatchObject({ success: false, errorCode: 1000, error: 'MISSING_BEARER_TOKEN' });
  });

  authed(USER_TOKEN)('answers an authenticated socket event with the envelope', async () => {
    const socket = connect(USER_TOKEN);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const page = await socket.timeout(5000).emitWithAck('notes:list', { limit: 1 });
    expect(page).toMatchObject({ success: true, meta: { page: 1 } });
  });

  authed(USER_TOKEN)('answers an authenticated GraphQL query', async () => {
    const res = await fetch(`${GRAPHQL}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER_TOKEN}` },
      body: JSON.stringify({ query: '{ notes(limit: 1) { meta { totalDocs } } }' }),
    });
    const body = (await res.json()) as { data?: unknown; errors?: unknown };
    expect(body.errors).toBeUndefined();
    expect(body.data).toMatchObject({ notes: { meta: { totalDocs: expect.any(Number) } } });
  });

  authed(ADMIN_TOKEN)('sees a heartbeat from every expected process', async () => {
    const res = await api('/api/v1/admin/ops/processes', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { mode: string }[] };
    expect([...new Set(data.map((p) => p.mode))].sort()).toEqual(expect.arrayContaining([...PROCESSES].sort()));
  });

  authed(ADMIN_TOKEN)('has a worker listening on every background queue', async () => {
    const res = await api('/api/v1/admin/ops/queues', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; workers: number | null }[] };
    // null: the Redis plan does not allow counting connections; the heartbeat check covers it.
    expect(data.filter((q) => q.workers === 0).map((q) => q.name)).toEqual([]);
  });
});
