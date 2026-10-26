# Ready for microservices (without being one)

The app is a **modular monolith**: one deployable, several processes, modules with hard boundaries.
Splitting a module into its own service later is a mechanical change, not a rewrite, because the
rules below hold from day one. ADRs: [0001](../adr/0001-modular-monolith-and-process-model.md),
[0009](../adr/0009-transactional-outbox.md), [0011](../adr/0011-one-transport-abstraction.md).

## The rules that make extraction cheap

1. **No module imports another module.** `src/modules/a/**` may import `common`, `infra`,
   `integrations`, `config` — never `src/modules/b`. ESLint enforces it (`no-restricted-imports`,
   one rule per module directory, built from the folder list), so a new module is covered without
   editing the config.
2. **Modules talk through ports** declared in `src/common/contracts` (abstract classes with plain
   types): `UserDirectory`, `Notifier`, `DeviceRegistry`, `NotesStats`. The owning module provides
   the implementation; the consumer injects the abstract class.
3. **Each module owns its collections.** No `$lookup` or model access across modules; data from
   another module comes through its port (batched: `findPublicProfiles(ids)`).
4. **Side effects across modules are events**, written to the outbox in the same transaction and
   delivered at least once to `@OnDomainEvent` handlers (`common/contracts/identity.events.ts`
   declares the identity events others react to: account deactivated, deleted, …).
5. **One transport abstraction** (`infra/transport/message-transport.ts`): request/response over
   gRPC or RabbitMQ RPC, events over RabbitMQ topics, with deadlines and classified failures.
   Which one carries a port is configuration (`TRANSPORT_ROUTES`), not code.

## Worked example: the examples module

The examples module offers `NotesStats` (note counts per owner); the identity module's admin user
detail shows them. Today, everything in-process:

```
identity UsersService ──injects──▶ NotesStats (abstract)  ◀── NotesStatsAdapter (examples, in-process)
```

Set `TRANSPORT_ROUTES=examples=grpc` (or `examples=rabbitmq`) and the same injection resolves to a
network client instead; identity's code does not change:

```
identity UsersService ──▶ NotesStats ◀── NotesStatsClient ── gRPC / RabbitMQ RPC ──▶ NotesRpcController (examples)
```

| Piece                         | File                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Port                          | `src/common/contracts/notes-stats.contract.ts`                                                                      |
| In-process adapter            | `src/modules/examples/notes-stats.adapter.ts`                                                                       |
| Wire contract                 | `proto/examples/v1/notes_stats.proto` (types: `pnpm proto:gen`, lint: `pnpm proto:lint`)                            |
| Server side (both transports) | `src/modules/examples/notes.rpc.ts` (`NotesStatsServiceControllerMethods` + `@RpcMethod`)                           |
| Client side                   | `src/infra/transport/clients/notes-stats.client.ts`                                                                 |
| Binding by route              | `src/modules/examples/notes.module.ts` (`localPorts`) and `src/infra/transport/transport.module.ts` (`remotePorts`) |
| Proof                         | `test/e2e/transport.e2e-spec.ts`: same call over gRPC and RabbitMQ, deadline on a dead server, events with confirms |

## Extracting a module, step by step

Using `examples` as the module to extract:

1. **Check the boundary.** `pnpm lint` passes (no imports into or out of `src/modules/examples`
   except through `common/contracts`). Every other module that needs it uses a port.
2. **Describe the wire contract** in `proto/<module>/v1/*.proto` for each port method; generate types
   (`pnpm proto:gen`) and serve them from an RPC controller next to the module's service, like
   `notes.rpc.ts`. Add a client in `infra/transport/clients/` implementing the port.
3. **Publish its events externally:** `EVENTS_EXTERNAL=rabbitmq` sends every outbox event to the
   `RABBITMQ_EXCHANGE` topic exchange (routing key = event type, message id = event id). The new
   service consumes the events it needs with `RabbitMqConsumerModule`, idempotently.
4. **Run it as its own deployment** from the same image first: the `grpc` process
   (`node dist/main.grpc.js`) serves the module's ports; the worker serves the RabbitMQ RPC queue.
   Point the monolith at it: `TRANSPORT_ROUTES=examples=grpc`, `GRPC_EXAMPLES_URL=<host:port>`.
   Watch latency and errors; roll back by removing the route.
5. **Move its data.** Its collections (`notes`) move to the new service's database (or stay in a
   database only it uses). Nothing else reads them, by rule 3.
6. **Move the code** to its own repository with `common`/`infra` as a shared package (or copied),
   delete the module from the monolith, keep the client and the proto.

What it costs: a network hop with a deadline (`GRPC_DEADLINE_MS`), eventual consistency for
cross-module side effects (already the case with the outbox), and one more deployment. Decide per
module; most should stay in the monolith.

## What is not done for you

Distributed tracing across services works only with `OTEL_ENABLED=true` (gRPC and amqplib are
auto-instrumented). Service discovery, mTLS between services and schema registries are left to the
platform.
