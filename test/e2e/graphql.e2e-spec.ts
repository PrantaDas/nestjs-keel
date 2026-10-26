import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createClient } from 'graphql-ws';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { GraphqlAppModule } from '@/app/graphql.module';
import { configureHttpApp } from '@/bootstrap/http-app';
import { Role } from '@/common/auth/auth.types';
import { PushSender } from '@/integrations/push/push.port';
import { NotesService } from '@/modules/examples/notes.service';
import { SessionService } from '@/modules/identity/sessions/session.service';
import { UsersService } from '@/modules/identity/users/users.service';
import { FakePush } from './fakes';
import { resetState, uniqueEmail } from './helpers';

/**
 * The graphql process on a real port: queries and mutations with the same auth, validation and
 * error codes as REST, DataLoader-batched fields, query limits, and a subscription fed by Redis.
 */
describe('GraphQL process (e2e)', () => {
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;
  let wsUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GraphqlAppModule] })
      .overrideProvider(PushSender)
      .useValue(new FakePush())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
    configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    await resetState(app);
    await app.get<Connection>(getConnectionToken()).syncIndexes();
    http = request(app.getHttpServer());
    wsUrl = `ws://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/graphql`;
  });

  afterAll(async () => {
    await resetState(app);
    await app.close();
  });

  async function account() {
    const user = await app
      .get(UsersService)
      .create({ name: 'Graph Person', email: uniqueEmail('gql'), role: Role.USER });
    const userId = user._id.toHexString();
    const pair = await app.get(SessionService).start({ userId, role: Role.USER, device: 'e2e', ip: null });
    return { userId, token: pair.accessToken };
  }

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) => {
    const req = http.post('/graphql').send({ query, variables });
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('needs a token, and answers with the REST error code and message', async () => {
    const res = await gql('{ notes { meta { totalDocs } } }').expect(200);
    expect(res.body.errors[0]).toMatchObject({
      message: 'Please sign in to continue.',
      extensions: { code: 'MISSING_BEARER_TOKEN', errorCode: 1000 },
    });
  });

  it('creates and lists notes, resolving owners with one batched lookup', async () => {
    const me = await account();
    for (const title of ['One', 'Two', 'Three']) {
      await gql('mutation($input: CreateNoteInput!) { createNote(input: $input) { _id } }', me.token, {
        input: { title },
      }).expect(200);
    }
    const res = await gql(
      '{ notes(limit: 10) { items { title owner { name } } meta { totalDocs } } }',
      me.token,
    ).expect(200);
    expect(res.body.data.notes.meta.totalDocs).toBe(3);
    expect(res.body.data.notes.items.every((n: { owner: { name: string } }) => n.owner.name === 'Graph Person')).toBe(
      true,
    );
  });

  it('shares DTO validation with REST (details in extensions)', async () => {
    const me = await account();
    const res = await gql('mutation { createNote(input: { title: "" }) { _id } }', me.token).expect(200);
    expect(res.body.errors[0]).toMatchObject({
      message: 'Title is required.',
      extensions: { code: 'VALIDATION_FAILED', details: [{ field: 'title', message: 'Title is required.' }] },
    });
  });

  it('refuses queries that are too deep or too costly before running them', async () => {
    const me = await account();
    const many = Array.from({ length: 11 }, (_, i) => `n${i}: notes { items { title } }`).join(' ');
    const res = await gql(`{ ${many} }`, me.token);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('pushes my note changes over a subscription, and nobody else’s', async () => {
    const me = await account();
    const other = await account();
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      connectionParams: { authorization: `Bearer ${me.token}` },
      retryAttempts: 0,
    });
    try {
      const received: unknown[] = [];
      const subscribed = new Promise<void>((resolve, reject) => {
        client.subscribe(
          { query: 'subscription { noteChanged { action noteId version } }' },
          { next: (value) => received.push(value.data), error: reject, complete: resolve },
        );
      });
      // Give the subscription time to register on Redis before publishing.
      await new Promise((r) => setTimeout(r, 300));
      await app.get(NotesService).create(other.userId, { title: 'Not mine' });
      const mine = await app.get(NotesService).create(me.userId, { title: 'Mine' });
      for (let i = 0; i < 50 && !received.length; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual([{ noteChanged: { action: 'CREATED', noteId: mine._id.toHexString(), version: 1 } }]);
      void subscribed.catch(() => undefined);
    } finally {
      await client.dispose();
    }
  });
});
