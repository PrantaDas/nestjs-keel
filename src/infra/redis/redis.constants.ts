/** Durable Redis (`noeviction`): locks, throttling, queues, socket pub/sub. */
export const REDIS_CORE = Symbol('REDIS_CORE');

/** Cache Redis (`allkeys-lru`): safe to lose any key at any time. `null` when not configured. */
export const REDIS_CACHE = Symbol('REDIS_CACHE');
