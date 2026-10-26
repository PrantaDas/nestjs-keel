import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { SocketModule } from '@/app/socket.module';
import { configureHttpApp } from '@/bootstrap/http-app';
import { Role } from '@/common/auth/auth.types';
import { RedisIoAdapter } from '@/infra/realtime/redis-io.adapter';
import { NotesService } from '@/modules/examples/notes.service';
import { SessionService } from '@/modules/identity/sessions/session.service';
import { UsersService } from '@/modules/identity/users/users.service';
import { PushSender } from '@/integrations/push/push.port';
import { FakePush } from './fakes';
import { resetState, uniqueEmail } from './helpers';

/**
 * The socket process on a real port: authenticated handshake (same token and live-session check as
 * REST), acks with the success / error envelope, pushes from other processes through the Redis
 * adapter, and revocation closing the sockets of a signed-out session.
 */
describe('Realtime: socket process (e2e)', () => {
  let app: NestExpressApplication;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SocketModule] })
      .overrideProvider(PushSender)
      .useValue(new FakePush())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
    configureHttpApp(app);
    const adapter = new RedisIoAdapter(app);
    await adapter.connectToRedis();
    app.useWebSocketAdapter(adapter);
    await app.listen(0, '127.0.0.1');
    await resetState(app);
    await app.get<Connection>(getConnectionToken()).syncIndexes();
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.close());
    await resetState(app);
    await app.close();
  });

  async function account() {
    const user = await app
      .get(UsersService)
      .create({ name: 'Socket person', email: uniqueEmail('socket'), role: Role.USER });
    const userId = user._id.toHexString();
    const pair = await app.get(SessionService).start({ userId, role: Role.USER, device: 'e2e', ip: null });
    return { userId, ...pair };
  }

  function connect(token?: string): Socket {
    const socket = io(url, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

  it('refuses a handshake without a token, with the error envelope in err.data', async () => {
    const error = await new Promise<{ data?: unknown }>((resolve) => connect().once('connect_error', resolve));
    expect(error.data).toMatchObject({ success: false, error: 'MISSING_BEARER_TOKEN', errorCode: 1000 });
  });

  it('answers events through the ack with the envelope, validated like REST', async () => {
    const me = await account();
    const socket = connect(me.accessToken);
    await connected(socket);
    const ok = await socket.timeout(5000).emitWithAck('notes:create', { title: 'From a socket' });
    expect(ok).toMatchObject({ success: true, data: { title: 'From a socket', version: 1 } });
    const bad = await socket.timeout(5000).emitWithAck('notes:create', { title: '' });
    expect(bad).toMatchObject({
      success: false,
      error: 'VALIDATION_FAILED',
      details: [{ field: 'title', message: 'Title is required.' }],
    });
  });

  it('pushes a change made elsewhere to every device of the owner (through Redis)', async () => {
    const me = await account();
    const socket = connect(me.accessToken);
    await connected(socket);
    const changed = new Promise<unknown>((resolve) => socket.once('notes:changed', resolve));
    await app.get(NotesService).create(me.userId, { title: 'Made over REST' });
    await expect(changed).resolves.toMatchObject({ action: 'created', version: 1 });
  });

  it('closes the sockets of a revoked session at once, and refuses it on reconnect', async () => {
    const me = await account();
    const socket = connect(me.accessToken);
    await connected(socket);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await app.get(SessionService).revoke(me.userId, me.sessionId);
    await expect(closed).resolves.toBeDefined();
    const error = await new Promise<{ data?: unknown }>((resolve) =>
      connect(me.accessToken).once('connect_error', resolve),
    );
    expect(error.data).toMatchObject({ error: 'SESSION_REVOKED' });
  });
});
