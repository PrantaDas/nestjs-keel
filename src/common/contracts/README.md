# Contracts (ports between modules)

A module never imports another module's files (ESLint `no-restricted-imports` fails the build).
When module A needs something from module B, the call goes through an **abstract class here**:

1. Declare the port here: an abstract class with the smallest methods A needs, plus plain types.
2. Module B implements it and provides it globally:
   `{ provide: UserDirectory, useExisting: UsersService }` in a `@Global()` module, exported.
3. Module A injects the abstract class: `constructor(private readonly users: UserDirectory) {}`.

Because A depends on the abstract class only, B can later be extracted to its own service and the
port re-implemented as a network client (gRPC or RabbitMQ) without touching A. See
`docs/architecture/microservices.md`.

Rules: plain data in and out (no Mongoose documents, no classes with behaviour), ids as strings,
instants as `Date`, batched methods (`ids[]` → `Map`) so callers never loop over single calls.
