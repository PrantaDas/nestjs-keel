/**
 * Owned by the examples (notes) module. Used by the users admin detail to show how many notes an
 * account has. It is also the worked example of extraction (docs/architecture/microservices.md):
 * with `TRANSPORT_ROUTES=examples=grpc` the same port is served by a gRPC client, unchanged callers.
 */
export abstract class NotesStats {
  /** Number of live (not deleted) notes per owner; owners without notes map to 0. */
  abstract countByOwners(ownerIds: readonly string[]): Promise<Map<string, number>>;
}
