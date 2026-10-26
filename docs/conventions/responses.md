# Responses

Every JSON answer has one of two shapes, for REST and for Socket.IO acks. Clients write one parser.
ADR: [0003](../adr/0003-response-envelope.md).

```jsonc
// success (2xx)
{ "success": true, "message": "Note created.", "data": { }, "meta": { /* only on paginated lists */ } }

// error (4xx / 5xx), whatever went wrong
{ "success": false, "errorCode": 5000, "error": "NOTE_NOT_FOUND",
  "errorMessage": "We couldn't find that note. It may have been deleted.",
  "details": [{ "field": "title", "message": "Title is required." }],   // validation and a few others
  "requestId": "3f1c2d9e-…" }                                             // matches logs and Sentry
```

## Rules

- **Controllers return plain data.** `ResponseEnvelopeInterceptor` wraps it; `AllExceptionsFilter`
  maps anything thrown. Never build an envelope by hand.
- **Every enveloped route sets `@ResponseMessage('…')`**: a short, specific sentence ("Note saved.").
  `test/unit/api-messages.spec.ts` fails on a missing or empty one.
- **Lists are paginated** with `?page=&limit=` (`PaginationQueryDto`, at most 100) and return a
  `PaginatedResult` (from `repository.paginate` / `aggregatePaginate`): `data` is the array, paging is
  in `meta` (`page`, `limit`, `totalDocs`, `totalPages`, `hasNextPage`, `hasPrevPage`), never inside
  `data`. A page that is an object (rows plus context) returns `PaginatedObject`.
- **Resource ids are `_id`** (24 hex characters) everywhere.
- **Views, not documents.** Services or controllers map documents to views (`toNoteView`): no
  storage keys, hashes, internal counters or other modules' data. App routes return URLs, never S3
  keys.
- **Status codes:** `201` for POST that creates, `200` otherwise, `204` (with `@HttpCode(204)`, no
  body) for deletes, `202` when work was queued (`ApiEnvelope` still applies).
- **Raw answers** (files, streams, webhooks for providers): `@SkipEnvelope()`.
- **Every response** carries `x-request-id` (sent back when the client sent a safe one) and
  `x-server-time`.

## Documenting a route

There is no Swagger CLI plugin: every route and every response property is decorated explicitly,
and `test/unit/openapi-contract.spec.ts` fails when the document and the code disagree.

```ts
@Get(':id')
@ApiOperation({ summary: 'One note', operationId: 'notesGet' })   // unique, stable camelCase id
@ApiEnvelope(NoteV2Response)                                      // or ApiPaginated / ApiEnvelopeArray / ApiNoContent / ApiEnvelopeNull
@ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND)                    // the route's own domain errors
@ResponseMessage('Note loaded.')
```

- Shared errors (validation, auth, roles, rate limit, malformed JSON, invalid id) are added
  automatically from the route's real guards and pipes.
- `@ApiBearerAuth()` on every route that needs a token, never on `@Public()` ones;
  `@ApiSecurity('apiKey')` on `@ApiKeyAuth()` routes.
- Response classes live next to the DTOs, mirror the views, and have unique names (the contract test
  catches two classes with one schema name). Helpers: `@ApiObjectIdProperty`, `@ApiDateTimeProperty`,
  `@ApiDayKeyProperty`, `@ApiMapProperty`, `@ApiFreeFormProperty`.
- A controller serving several versions appears once per version; older versions get an
  operation id suffix (`notesCreateV1`) so generated clients stay unique.

`pnpm openapi:export` writes `openapi.json` without a database (for client generation), and
`pnpm postman:export` turns it into a Postman collection with a local environment. Swagger UI is
at `/api/docs` (JSON at `/api/docs-json`) when `SWAGGER_ENABLED=true`.
