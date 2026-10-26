#!/usr/bin/env node
/*
 * pnpm dev [process...]          default: api graphql socket worker cron
 * pnpm dev api graphql socket    only those
 * pnpm dev:api                   one process (same as `pnpm dev api`)
 *
 * One compiler for every process: `nest build --watch` writes dist/ once, and each process runs
 * from it (`node dist/main.<process>.js`). After every successful rebuild the processes restart
 * one by one (graceful stop first, so ports are free); a build with type errors leaves them
 * running as they were. Output is prefixed per process.
 *
 * Why not one `nest start --watch` per process: each would compile into the same dist/ and delete
 * it on start (`deleteOutDir`), so one process loads files another compiler just removed
 * ("Cannot find module …"). Run several processes through this one command instead.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ALL = ['api', 'graphql', 'socket', 'worker', 'cron', 'grpc'];
const DEFAULT = ['api', 'graphql', 'socket', 'worker', 'cron'];
const requested = process.argv.slice(2);
const names = requested.length ? requested : DEFAULT;
const unknown = names.filter((name) => !ALL.includes(name));
if (unknown.length) {
  console.error(`Unknown process: ${unknown.join(', ')}. Choose from: ${ALL.join(', ')}.`);
  process.exit(1);
}

// ── One runner per checkout: a second one would start a second compiler on the same dist/ ──
const LOCK = 'node_modules/.cache/dev-runner.pid';
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const holder = existsSync(LOCK) ? Number(readFileSync(LOCK, 'utf8')) : 0;
if (holder && holder !== process.pid && alive(holder)) {
  console.error(
    `pnpm dev is already running here (pid ${holder}). Stop it, then start every process you need in\n` +
      `one command, e.g. pnpm dev api graphql socket.`,
  );
  process.exit(1);
}
mkdirSync('node_modules/.cache', { recursive: true });
writeFileSync(LOCK, String(process.pid));

const COLORS = { build: 90, api: 36, graphql: 35, socket: 33, worker: 32, cron: 34, grpc: 31 };
const width = Math.max(...names.map((n) => n.length), 'build'.length);
const tag = (name) => `\x1b[${COLORS[name]}m${name.padEnd(width)}\x1b[0m │`;

/** Forwards a stream line by line with the process tag; `onLine` sees the plain line. */
function pipe(stream, name, onLine) {
  createInterface({ input: stream }).on('line', (line) => {
    console.log(`${tag(name)} ${line}`);
    onLine?.(line);
  });
}

// ── Processes ────────────────────────────────────────────────────────────────
const children = new Map();
let stopping = false;

function start(name) {
  const child = spawn(process.execPath, ['--enable-source-maps', `dist/main.${name}.js`], {
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: Ctrl-C reaches only this runner, which then stops each process gracefully
    // (a second signal would make the app exit at once).
    detached: true,
  });
  pipe(child.stdout, name);
  pipe(child.stderr, name);
  child.on('exit', (code, signal) => {
    if (children.get(name) === child) children.delete(name);
    if (!stopping && !child.restarting) {
      console.log(`${tag(name)} exited (${signal ?? code}); it starts again after the next successful build`);
    }
  });
  children.set(name, child);
}

/** Graceful stop (the app drains and closes within SHUTDOWN_TIMEOUT_MS); forced after 30 s. */
function stop(name) {
  const child = children.get(name);
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.restarting = true;
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

let cycle = Promise.resolve();
/** Restarts every process after a build, one at a time, never two cycles at once. */
function restartAll() {
  cycle = cycle.then(async () => {
    for (const name of names) {
      if (!existsSync(`dist/main.${name}.js`)) {
        console.log(`${tag(name)} dist/main.${name}.js is missing: not started`);
        continue;
      }
      await stop(name);
      if (!stopping) start(name);
    }
  });
}

// ── Compiler ─────────────────────────────────────────────────────────────────
const nestBin = 'node_modules/.bin/nest';
const builder = spawn(nestBin, ['build', '--watch', '--preserveWatchOutput'], {
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const onBuildLine = (line) => {
  const found = /Found (\d+) errors?/.exec(line);
  if (!found) return;
  if (found[1] === '0') restartAll();
  else console.log(`${tag('build')} type errors: processes keep running the previous build`);
};
pipe(builder.stdout, 'build', onBuildLine);
pipe(builder.stderr, 'build', onBuildLine);
builder.on('exit', (code) => {
  if (!stopping) {
    console.error(`${tag('build')} compiler exited (${code})`);
    shutdown(1);
  }
});

console.log(`${tag('build')} compiling; then starting ${names.join(', ')}. Ctrl-C stops everything.`);

// ── Ctrl-C ───────────────────────────────────────────────────────────────────
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  builder.kill('SIGTERM');
  await Promise.all([...children.keys()].map(stop));
  rmSync(LOCK, { force: true });
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
