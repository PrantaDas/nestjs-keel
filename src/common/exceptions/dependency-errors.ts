/** Runtime dependencies whose outage turns into a 503 envelope instead of a 500. */
export type Dependency = 'mongodb' | 'redis';

/** MongoDB driver / Mongoose errors that mean "no usable server right now". */
const MONGO_UNAVAILABLE = new Set([
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoClientClosedError',
  'MongoPoolClearedError',
  'MongoPoolClosedError',
  'MongoServerClosedError',
  'MongoWaitQueueTimeoutError',
  'MongoOperationTimeoutError',
]);

/** Labels the driver puts on errors that a later retry can succeed on. */
const MONGO_TRANSIENT_LABELS = [
  'TransientTransactionError',
  'UnknownTransactionCommitResult',
  'RetryableWriteError',
  'ResetPool',
];

/**
 * Server error codes for elections, step-downs and shutdowns (the not-primary family), which reads
 * get without a label: HostUnreachable, HostNotFound, NetworkTimeout, ShutdownInProgress,
 * PrimarySteppedDown, SocketException, NotWritablePrimary, InterruptedAtShutdown,
 * InterruptedDueToReplStateChange, NotPrimaryNoSecondaryOk, NotPrimaryOrSecondary.
 */
const MONGO_UNAVAILABLE_CODES = new Set([6, 7, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436]);

/** ioredis command failures while the server is unreachable, slow or refusing writes. */
const REDIS_UNAVAILABLE_MESSAGES = [
  'Command timed out',
  "Stream isn't writeable",
  'Connection is closed',
  'Connection in subscriber mode',
];
const REDIS_REPLY_PREFIXES = ['OOM ', 'LOADING', 'READONLY', 'MASTERDOWN', 'TRYAGAIN', 'CLUSTERDOWN'];

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  hasErrorLabel?: (label: string) => boolean;
}

/**
 * Which dependency an error says is unavailable (down, unreachable, too slow, failing over), or
 * undefined for anything else, including ordinary query errors such as duplicate keys. Looks one
 * level into `cause` so wrapped driver errors still count.
 */
export function unavailableDependency(error: unknown, depth = 0): Dependency | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as ErrorShape;
  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';

  if (MONGO_UNAVAILABLE.has(name)) return 'mongodb';
  if (name === 'MongooseError' && message.includes('buffering timed out')) return 'mongodb';
  if (name.startsWith('Mongo')) {
    if (typeof err.hasErrorLabel === 'function' && MONGO_TRANSIENT_LABELS.some((l) => err.hasErrorLabel!(l))) {
      return 'mongodb';
    }
    if (typeof err.code === 'number' && MONGO_UNAVAILABLE_CODES.has(err.code)) return 'mongodb';
  }

  if (name === 'MaxRetriesPerRequestError') return 'redis';
  if (name === 'ReplyError' && REDIS_REPLY_PREFIXES.some((p) => message.startsWith(p))) return 'redis';
  if (name === 'Error' && REDIS_UNAVAILABLE_MESSAGES.some((m) => message.startsWith(m))) return 'redis';

  return depth === 0 ? unavailableDependency(err.cause, 1) : undefined;
}
