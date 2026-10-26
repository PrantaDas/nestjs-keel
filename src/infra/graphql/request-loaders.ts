import DataLoader from 'dataloader';

/**
 * Per-request DataLoader registry, created in the GraphQL context for each operation: resolvers
 * fetch related data through it (`loaders.get('userProfiles', batchFn).load(id)`), so a list of 50
 * notes resolves its 50 owners with one batched query instead of 50 (the N+1 problem). Loaders are
 * never shared between requests: caches would leak across users.
 */
export class RequestLoaders {
  private readonly loaders = new Map<string, DataLoader<string, unknown>>();

  get<V>(name: string, batch: (keys: readonly string[]) => Promise<Map<string, V>>): DataLoader<string, V | null> {
    let loader = this.loaders.get(name) as DataLoader<string, V | null> | undefined;
    if (!loader) {
      loader = new DataLoader<string, V | null>(async (keys) => {
        const found = await batch(keys);
        return keys.map((key) => found.get(key) ?? null);
      });
      this.loaders.set(name, loader);
    }
    return loader;
  }
}
