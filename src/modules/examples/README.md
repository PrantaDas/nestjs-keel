# Example module: notes

The file a new developer (or an AI agent) copies. Every convention of the codebase appears here
once, with a comment explaining why. `pnpm g:module <name>` copies this folder, renames it and
wires it into the process modules.

| File                                           | Shows                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `schemas/note.schema.ts`                       | Schema, explicit prop types, indexes named after their queries, a stored `DayKey`, opt-in soft delete    |
| `dto/note.dto.ts`                              | Validation that is also the GraphQL input, wall-clock input (`LocalDateTimeDto`), list query with paging |
| `dto/note.responses.ts`                        | Swagger response models mirroring the views                                                              |
| `notes.errors.ts`                              | The module's error range and catalogue                                                                   |
| `notes.events.ts`                              | Domain events written to the outbox                                                                      |
| `notes.repository.ts`                          | Intent-named queries, optimistic concurrency, claims, aggregation                                        |
| `notes.views.ts`                               | What leaves the server, per API version                                                                  |
| `notes.service.ts`                             | Rules, transactions + outbox, cache, realtime and GraphQL pushes, the `NotesStats` port                  |
| `notes.controller.ts`                          | REST, Swagger decorators, v1 and v2 side by side, `@Deprecated`                                          |
| `notes.resolver.ts` + `notes.graphql-types.ts` | GraphQL query, mutation, subscription, DataLoader field                                                  |
| `notes.gateway.ts`                             | Socket.IO events with acks                                                                               |
| `notes.processor.ts`                           | BullMQ job (policy in `infra/queue/queue-policies.ts`)                                                   |
| `notes.cron.ts`                                | `@LockedCron` sweeps with an explicit zone                                                               |
| `notes.handlers.ts`                            | Reacting to another module's domain event                                                                |
| `notes.module.ts`                              | One small module per process                                                                             |
| `notes.service.spec.ts`                        | Unit tests of the rules                                                                                  |
| `test/e2e/notes.e2e-spec.ts`                   | End-to-end tests against real MongoDB and Redis                                                          |

Error range: 5000–5099. Queue: `notes`. Socket events: `notes:list`, `notes:create` (client → server,
with ack) and `notes:changed` (server → client). GraphQL: `notes`, `note`, `createNote`,
`updateNote`, `deleteNote`, `noteChanged`.
