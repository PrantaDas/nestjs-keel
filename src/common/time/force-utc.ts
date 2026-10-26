/*
 * First import of every entry point. App logic never depends on the server's zone (ESLint and
 * the multi-zone test run enforce that); pinning UTC keeps logs, third-party libraries and ops
 * tooling consistent anyway, whatever the host is configured with.
 */
process.env.TZ = 'UTC';

if (new Date().getTimezoneOffset() !== 0) {
  throw new Error('[time] Process timezone could not be pinned to UTC; refusing to start.');
}
