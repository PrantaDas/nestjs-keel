# GraphQL

The `graphql` process serves `/graphql` (HTTP and `graphql-ws` subscriptions) from the same modules,
services and guards as REST. ADR: [0010](../adr/0010-graphql-separate-process.md).

## Code first, schema committed

Types come from decorated classes (`@ObjectType`, `@InputType`, `@Field`); `schema.gql` is generated
(`pnpm graphql:schema`, sorted) and committed so reviews show every schema change.
`test/unit/graphql-schema.spec.ts` fails when it is stale. The running process builds the schema in
memory and never writes files.

## Resolvers

```ts
@Resolver(() => NoteType)
export class NotesResolver {
  @Query(() => NotePageType) notes(@CurrentUser('id') me: string, @Args() query: NoteQueryArgs) { … }
  @Mutation(() => NoteType) createNote(@CurrentUser('id') me: string, @Args('input') input: CreateNoteDto) { … }
  @ResolveField(() => NoteOwnerType, { nullable: true })
  owner(@Parent() note: NoteType, @Context() context: GraphqlContext) {
    return context.loaders.get('userProfiles', (ids) => this.directory.findPublicProfiles(ids)).load(note.ownerId);
  }
}
```

- Thin, like controllers: call the same service, map with the same views.
- **Input DTOs are shared with REST** (one class decorated for both), validated by the same pipe
  and messages.
- **Auth is the same:** the global `JwtAuthGuard` / `RolesGuard` read the GraphQL context;
  `@Public()`, `@RequirePermissions()`, `@CurrentUser()` work as in REST. Rate limits apply per
  operation.
- **No N+1:** related data goes through the per-operation DataLoader registry (`context.loaders`).
  Loaders are created per request, never shared (their caches would leak across users).
- Lists return a page type (`items` + `meta: PageInfo`, shared), with the same `limit` cap as REST.
- Type names are unique across the schema; enums are registered with `registerEnumType`.

## Limits

`GRAPHQL_MAX_DEPTH` (8) and `GRAPHQL_MAX_COMPLEXITY` (1000, `graphql-query-complexity`: each field costs 1, a
list field declares its multiplier, e.g. `@Field(() => [NoteType], { complexity: 100 })`) reject expensive queries before they run
(`QUERY_TOO_DEEP`, `QUERY_TOO_COMPLEX`). Introspection follows `GRAPHQL_INTROSPECTION` (off in
production by default); automatic persisted queries are on.

## Errors

Same registry and messages as REST. `errors[].message` is the human `errorMessage`;
`errors[].extensions` holds `code`, `errorCode`, `details` and `requestId`
([errors.md](errors.md#graphql)).

## Subscriptions

`graphql-ws`, authenticated with the access token in `connectionParams.authorization`
(`Bearer …`), checked like any request (live session). Events are published from any process through
`GraphqlPubSub` (Redis pub/sub) and filtered per subscriber:

```ts
@Subscription(() => NoteChangeType, { filter: (p, _a, ctx) => p.noteChanged.ownerId === ctx.req.user?.id })
noteChanged() { return this.pubsub.asyncIterator(NOTES_CHANGED_EVENT); }
```
