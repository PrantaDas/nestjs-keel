/**
 * Guard for anything that writes throwaway data: tests and the dev seed must only ever reach a
 * database on this machine. A remote URI (a staging or production cluster, or a copy of one) is
 * refused before a connection is opened, so a mistyped `MONGO_URI` or a stray `.env` value cannot
 * wipe real data or make the app send real notifications to real people.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'mongo']);

/** Hosts of a Mongo URI, without credentials, ports or options. */
export function mongoHosts(uri: string): string[] {
  const after = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const hostPart = after.slice(after.lastIndexOf('@') + 1).split(/[/?]/)[0];
  return hostPart
    .split(',')
    .map((host) => host.trim().replace(/:\d+$/, '').toLowerCase())
    .filter(Boolean);
}

export function isLocalMongoUri(uri: string): boolean {
  // mongodb+srv always resolves elsewhere: a local server is never reached through DNS seedlist.
  if (/^mongodb\+srv:/i.test(uri)) return false;
  const hosts = mongoHosts(uri);
  return hosts.length > 0 && hosts.every((host) => LOCAL_HOSTS.has(host));
}

/**
 * Throws unless `uri` points at this machine. `context` names the caller in the message
 * ("e2e tests", "pnpm seed"), and `escapeHatch` names the flag that would allow it, when one exists.
 */
export function assertLocalMongoUri(uri: string, context: string, escapeHatch?: string): void {
  if (isLocalMongoUri(uri)) return;
  const hosts = /^mongodb\+srv:/i.test(uri) ? 'a mongodb+srv cluster' : mongoHosts(uri).join(', ') || 'an unknown host';
  throw new Error(
    `Refusing to run ${context} against ${hosts}: only a database on this machine is allowed.\n` +
      'This guard exists because test and seed data overwrite collections and can trigger real sends.\n' +
      `Point MONGO_URI at localhost (for example the docker compose infra: pnpm infra:up)${
        escapeHatch ? `, or pass ${escapeHatch} if this really is a disposable copy` : ''
      }.`,
  );
}
