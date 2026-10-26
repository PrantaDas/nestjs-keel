#!/usr/bin/env node
/*
 * pnpm playground  →  http://localhost:5173
 *
 * Serves the playground page and the two browser clients it needs straight from node_modules
 * (socket.io-client, graphql-ws), so it works offline and adds no dependency. Port 5173 is already
 * in CORS_ORIGINS of .env.example, so the api, graphql and socket processes accept it as is.
 * Local development only: it serves files, nothing else.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = Number(process.env.PLAYGROUND_PORT ?? 5173);

/** URL prefix → directory. Anything else is a 404. */
const MOUNTS = [
  ['/vendor/socket.io/', join(ROOT, 'node_modules/socket.io-client/dist')],
  ['/vendor/graphql-ws/', join(ROOT, 'node_modules/graphql-ws/dist')],
  ['/', HERE],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
};

function resolve(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rest = urlPath.slice(prefix.length) || 'index.html';
    const file = normalize(join(dir, rest));
    // No escaping the mounted directory (`/../../.env`).
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    if (dir === HERE && !['.html'].includes(extname(file))) return null;
    return file;
  }
  return null;
}

createServer((req, res) => {
  const file = resolve(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  if (req.method !== 'GET' || !file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Playground on http://localhost:${PORT}`);
  console.log('Needs the api, graphql and socket processes running: pnpm dev (or pnpm dev api graphql socket).');
});
