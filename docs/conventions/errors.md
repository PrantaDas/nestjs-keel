# Errors

Expected failures are domain exceptions from a **central registry**, never `throw new Error()`.
Clients branch on `errorCode` / `error` (stable), and show `errorMessage` (written for people).

## Declaring errors

Each module owns a block of codes and declares its catalogue once, in `<module>.errors.ts`:

```ts
export const NotesErrors = defineErrors('notes', [5000, 5099], {
  NOTE_NOT_FOUND: {
    code: 5000,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that note. It may have been deleted.",
  },
});
export class NotesException extends BaseException {}
throw new NotesException(NotesErrors.NOTE_NOT_FOUND);
throw new NotesException(NotesErrors.NOTE_EDITED_ELSEWHERE, {
  details: [{ field: 'expectedVersion', message: '…', latestVersion: 4 }],
});
```

`defineErrors` runs at import time: **a duplicate code or a code outside the module's range stops
the boot** (and the unit tests). `pnpm g:module` picks the next free block.

## Ranges

| Range                | Owner                                                     | File                                            |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| 1000–1099            | auth (tokens)                                             | `common/exceptions/error-codes.ts`              |
| 1100–1199            | auth-access (sessions, accounts, API keys)                | `common/auth/auth-access.errors.ts`             |
| 2000–2999            | request (validation, JSON, limits, idempotency, webhooks) | `common/exceptions/error-codes.ts`              |
| 3000–3199            | identity                                                  | `modules/identity/identity.errors.ts`           |
| 4000–4099            | notifications                                             | `modules/notifications/notifications.errors.ts` |
| 5000–5099            | examples (notes)                                          | `modules/examples/notes.errors.ts`              |
| 6000–6099            | payments                                                  | `modules/payments/payments.errors.ts`           |
| 7000–7099            | ops                                                       | `modules/ops/ops.errors.ts`                     |
| 9000–9149, 9200–9999 | system (internal error, dependencies down, timeouts)      | `common/exceptions/error-codes.ts`              |
| 9150–9199            | integrations (circuit open, outcome unknown)              | `integrations/resilience/failure.ts`            |

The full, current list with every message is generated: [docs/api/messages.md](../api/messages.md).

## What the mapper does with everything else

`common/exceptions/exception-mapper.ts` turns anything thrown into the envelope:

| Thrown                                                       | Answer                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `BaseException`                                            | Its catalogue entry (status, code, key, message, details)                                                                                                     |
| Nest `HttpException` (404 route, 413 body, 429 throttler, …) | The matching generic entry; the framework's own text never leaks                                                                                              |
| MongoDB duplicate key (E11000)                               | 409 `DUPLICATE_RESOURCE`; a unique index registered with `defineDuplicateKeys` gets its own sentence and names the request field (only if the client sent it) |
| Mongoose `CastError` / `ValidationError`                     | 400 with human messages built from the field labels, never "Path `x` is required"                                                                             |
| MongoDB or Redis unreachable / too slow                      | 503 `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` with `Retry-After`, reported to Sentry at most once a minute                                                 |
| Anything else                                                | 500 `INTERNAL_ERROR`: one calm sentence plus the `requestId`; the real error goes to logs and Sentry only                                                     |

Unique indexes a race can hit are declared next to the catalogue:

```ts
defineDuplicateKeys('users', [{ fields: ['email'], field: 'email', message: IdentityErrors.EMAIL_TAKEN.message }]);
```

## GraphQL

GraphQL answers HTTP 200 with an `errors` array, so the same contract travels in the error itself:
`message` is the human `errorMessage`, and `extensions` holds `code` (the key, e.g.
`NOTE_NOT_FOUND`), `errorCode`, `details` and `requestId` (`infra/graphql/graphql-errors.ts`, same
mapper as REST). Errors about the query itself (syntax, unknown field, `QUERY_TOO_DEEP`,
`QUERY_TOO_COMPLEX`) keep GraphQL's message: they are for developers.

## Sockets

Handlers throw the same exceptions; `WsExceptionsFilter` answers through the ack callback with the
error envelope, or emits `exception` when the client sent no ack. A refused handshake arrives as
`connect_error` with the envelope in `err.data`.

## Jobs

`BaseProcessor` fails a job at once (no more retries) when the error says a retry cannot help
(`retryable: false`, `INTEGRATION_NOT_CONFIGURED`), and reports to Sentry once, when the job failed
for good.
