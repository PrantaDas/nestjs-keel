# Testing

| Suite         | Command                                   | Needs                        | What                                                                                                  |
| ------------- | ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unit          | `pnpm test`                               | nothing                      | `src/**/*.spec.ts` + `test/unit` (contracts: messages, OpenAPI, GraphQL schema)                       |
| Unit, 4 zones | `pnpm test:tz`                            | nothing                      | The unit suite under UTC, Asia/Dubai, America/Los_Angeles, Pacific/Kiritimati                         |
| E2E           | `pnpm test:e2e`                           | `pnpm infra:up`              | Real modules against compose MongoDB, Redis, RabbitMQ; providers faked                                |
| E2E, 2 zones  | `pnpm test:tz:e2e`                        | `pnpm infra:up`              | The e2e suite under Asia/Dubai and Pacific/Kiritimati                                                 |
| Smoke         | `pnpm test:smoke`                         | running processes            | Read-only checks of a live deployment                                                                 |
| Load          | `k6 run test/load/baseline.k6.js`         | k6, running API              | Baseline profile with thresholds                                                                      |
| Playground    | `pnpm playground` → http://localhost:5173 | api, graphql, socket running | Clicks through REST, GraphQL, subscriptions and Socket.IO together; `?auto=1` runs all checks on load |

NestJS 12 ships as ES modules, so Jest runs with `--experimental-vm-modules` (set in the scripts).

## Unit tests

Next to the code (`notes.service.spec.ts`). Pure logic (time math, policies, mappers, guards)
gets unit tests; anything about queries, transactions, Redis scripts or HTTP gets e2e tests instead
of mocks of Mongoose.

**Never read the wall clock in tests either:** pass a `FixedClock` and move it
(`clock.set(...)`, `clock.advance(ms)`).

## E2E tests

```ts
const clock = new FixedClock('2026-10-26T08:00:00Z');
const t = await createTestApp({ clock, imports: [NotesJobsModule, NotesCronModule] });
const me = await signUp(t.http); // a real account and session
await t.http.post(`${API}/notes`).set(me.auth).send({ title: 'A' }).expect(201);
await eventually(async () => t.fakes.push.sentTo('token-1').length === 1); // async work
```

- `createTestApp` boots `ApiModule` (or `module:`) plus extra modules (worker processors, crons)
  with every provider replaced by a fake from `test/e2e/fakes.ts` (`t.fakes.mail`, `sms`, `push`,
  `storage`, `payments`), and an optional clock.
- **Isolation:** each run and each Jest worker gets its own database (`app_e2e_w2`) and Redis key
  prefix; `E2E_ID=<name>` adds a suffix so two checkouts can run at once. `setup-env.ts` refuses a
  non-local `MONGO_URI`.
- Crons are called directly (`t.app.get(NotesCron).queueDueReminders()`); there is no scheduler in
  tests. Queued jobs run when the module's processor is imported.
- Helpers: `signUp`, `staffAccount(role)`, `signedIn`, `lastCodeFor(recipient)` (reads the OTP job),
  `eventually(probe)`, `E2E_API_KEY`.
- The e2e business zone is **Asia/Dubai** on purpose; pick frozen times far from midnight and DST
  changes unless the test is about them.

## Contract tests (fail the build when docs drift)

- `test/unit/api-messages.spec.ts`: every message is a sentence for people; `docs/api/messages.md`
  is current (`pnpm messages:export`).
- `test/unit/openapi-contract.spec.ts`: every route documents its envelope, errors and auth; unique
  operation ids; no secret fields in responses.
- `test/unit/graphql-schema.spec.ts`: `schema.gql` is current (`pnpm graphql:schema`).

## Playground

`tools/playground/` is a single page served by `pnpm playground` (port 5173, already allowed by
`CORS_ORIGINS`). It uses the real browser clients (`socket.io-client`, `graphql-ws`, served from
`node_modules`) against the running api, graphql and socket processes: sign up, live Socket.IO and
GraphQL subscription feeds, create and list notes over every channel, and a notes table that
reloads itself on every subscription event (Pin and Delete are GraphQL mutations that never touch the
table: the change comes back through the subscription, to every tab of that person). **Run all checks** creates a
fresh account and verifies, in order: handshake refusal without a token, both live channels, one
note per channel, every push on both feeds, the three lists, the same error contract on REST,
GraphQL and Socket.IO, and the live table following a pin and a delete by itself. Other hosts: `?api=…&graphql=…&socket=…` (add the page's origin to
`CORS_ORIGINS`).

## Smoke and load

`pnpm test:smoke` checks a running deployment without writing anything: every HTTP process alive
and ready, socket handshake refusal and an authenticated event, an authenticated GraphQL query,
heartbeats of every process, a worker on every queue. Configure with `SMOKE_API_URL`,
`SMOKE_GRAPHQL_URL`, `SMOKE_SOCKET_URL`, `SMOKE_USER_TOKEN` (`pnpm dev:token <userId>`),
`SMOKE_ADMIN_TOKEN`, `SMOKE_PROCESSES`. Run it right after every deploy.

`test/load/baseline.k6.js` is a skeleton with thresholds; it writes notes, so point it at a
production-like environment, never production.

## Definition of done for a change

`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all green, generated
docs regenerated, a test for the behaviour (and for the bug, when fixing one).
