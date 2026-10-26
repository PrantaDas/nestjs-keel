import type { mongo } from 'mongoose';

/**
 * Walks a collection in `_id` order, `batchSize` documents at a time, without loading it all
 * into memory and without a long-lived cursor (safe for millions of documents).
 */
export async function forEachBatch<T extends mongo.Document>(
  collection: mongo.Collection<T>,
  filter: mongo.Filter<T>,
  batchSize: number,
  handle: (docs: mongo.WithId<T>[]) => Promise<void>,
): Promise<number> {
  let lastId: unknown;
  let total = 0;

  for (;;) {
    const page = await collection
      .find(lastId ? ({ $and: [filter, { _id: { $gt: lastId } }] } as mongo.Filter<T>) : filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (page.length === 0) return total;

    await handle(page);
    total += page.length;
    lastId = page[page.length - 1]._id;
  }
}
