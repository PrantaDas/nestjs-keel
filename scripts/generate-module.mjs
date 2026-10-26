#!/usr/bin/env node
/*
 * pnpm g:module <name> [--dry-run]
 *
 * Writes a complete feature module from the example (src/modules/examples, the "notes" resource):
 * schema, DTOs, errors (a free code range), repository, service, REST controllers, GraphQL resolver,
 * socket gateway, processor (its own queue with a policy), crons, event handlers, unit and e2e tests;
 * and wires it into every process module and the CLI module. The example's port and RPC handler
 * (`// #region port`) are left out: a new module starts private.
 *
 * <name> is the plural resource in kebab case: `invoices`, `support-tickets`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'src/modules/examples');
const SKIP = new Set(['README.md', 'notes.rpc.ts', 'notes-stats.adapter.ts']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const plural = args.find((arg) => !arg.startsWith('--'));

if (!plural || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*s$/.test(plural)) {
  console.error('Usage: pnpm g:module <name> [--dry-run]\n  <name>: plural kebab case ending in s, e.g. invoices, support-tickets');
  process.exit(1);
}
if (['examples', 'identity', 'notifications', 'payments', 'ops', 'audit'].includes(plural)) {
  console.error(`"${plural}" is taken by an existing module.`);
  process.exit(1);
}

// ── Names ─────────────────────────────────────────────────────────────────────
const singular = plural.endsWith('ies') ? `${plural.slice(0, -3)}y` : plural.replace(/s$/, '');
const words = (kebab) => kebab.split('-');
const pascal = (kebab) => words(kebab).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const camel = (kebab) => pascal(kebab)[0].toLowerCase() + pascal(kebab).slice(1);
const upper = (kebab) => words(kebab).join('_').toUpperCase();
const N = {
  Plural: pascal(plural),
  Singular: pascal(singular),
  plural: camel(plural),
  singular: camel(singular),
  PLURAL: upper(plural),
  SINGULAR: upper(singular),
  kebabPlural: plural,
  kebabSingular: singular,
};
const target = join(ROOT, 'src/modules', plural);
if (existsSync(target)) {
  console.error(`src/modules/${plural} already exists.`);
  process.exit(1);
}

// ── Error range: the next free block of 100 in 5000–8999 ─────────────────────
function usedRanges() {
  const ranges = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith('.ts')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/defineErrors\(\s*'[^']+',\s*\[(\d+),\s*(\d+)\]/g)) {
          ranges.push([Number(match[1]), Number(match[2])]);
        }
      }
    }
  };
  visit(join(ROOT, 'src'));
  return ranges;
}
const ranges = usedRanges();
let base = 5000;
while (ranges.some(([min, max]) => base <= max && base + 99 >= min)) base += 100;
if (base > 8900) {
  console.error('No free error range left in 5000–8999.');
  process.exit(1);
}

// ── Text transformation ──────────────────────────────────────────────────────
function stripPortRegions(text) {
  return text.replace(/^[ \t]*\/\/ #region port[\s\S]*?\/\/ #endregion port[ \t]*\n/gm, '');
}

function transform(text) {
  let out = stripPortRegions(text)
    // What the port regions left behind in notes.module.ts.
    .replace(/, \.\.\.localPorts\]/g, ']')
    .replace(/, \.\.\.\(localPorts\.length \? \[NotesStats\] : \[\]\)\]/g, ']')
    .replace(/^import \{ features \} from '@\/config\/configuration';\n/m, '')
    .replace(/import \{ Global, Module, Provider \} from '@nestjs\/common';/, "import { Module } from '@nestjs/common';")
    .replace(/@Global\(\)\n@Module/g, '@Module')
    .replace(
      / \* The core module is `@Global` only because it provides a port \(`NotesStats`\) other modules\n \* consume; a module without ports keeps its core module local\.\n/,
      ' * A module that other modules need offers a port in common/contracts (see the examples module).\n',
    )
    // Error codes: the example's 50xx → this module's range.
    .replace(/\[5000, 5099\]/g, `[${base}, ${base + 99}]`)
    .replace(/code: 50(\d\d),/g, (_m, offset) => `code: ${base + Number(offset)},`)
    .replace(/Range: 5000–5099/g, `Range: ${base}–${base + 99}`)
    // Paths and names.
    .replace(/@\/modules\/examples\//g, `@/modules/${plural}/`)
    .replace(/QueueName\.NOTES\b/g, `QueueName.${N.PLURAL}`)
    .replace(/NOTES_/g, `${N.PLURAL}_`)
    .replace(/NOTE_/g, `${N.SINGULAR}_`)
    .replace(/Notes/g, N.Plural)
    .replace(/Note/g, N.Singular)
    .replace(/notes/g, N.plural)
    .replace(/note/g, N.singular);
  // Kebab forms in URLs, events and cron names (`support-tickets`), when they differ from camel case.
  if (N.plural !== N.kebabPlural) {
    out = out
      .replace(new RegExp(`path: '${N.plural}'`, 'g'), `path: '${N.kebabPlural}'`)
      .replace(new RegExp(`'${N.plural}:`, 'g'), `'${N.kebabPlural}:`)
      .replace(new RegExp(`${N.plural}-`, 'g'), `${N.kebabPlural}-`)
      .replace(new RegExp(`/${N.plural}`, 'g'), `/${N.kebabPlural}`)
      .replace(new RegExp(`${N.singular}-`, 'g'), `${N.kebabSingular}-`)
      .replace(new RegExp(`/${N.singular}\\.`, 'g'), `/${N.kebabSingular}.`);
  }
  return out;
}

/** Messages are for people: `supportTicket` reads "support ticket" there. */
function humanize(text) {
  const spaced = (kebab) => words(kebab).join(' ');
  return text.replace(/^.*message: .*$/gm, (line) =>
    line.replace(new RegExp(N.plural, 'g'), spaced(plural)).replace(new RegExp(N.singular, 'g'), spaced(singular)),
  );
}

const renameFile = (name) =>
  name.replace(/^notes(?=[.-])/, N.kebabPlural).replace(/^note(?=[.-])/, N.kebabSingular);

// ── Plan ─────────────────────────────────────────────────────────────────────
const writes = new Map();

function copyTree(from, to) {
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry)) continue;
    const source = join(from, entry);
    if (statSync(source).isDirectory()) copyTree(source, join(to, entry));
    else writes.set(join(to, renameFile(entry)), humanize(transform(readFileSync(source, 'utf8'))));
  }
}
copyTree(EXAMPLE, target);

writes.set(
  join(target, 'README.md'),
  `# ${N.Plural}\n\nGenerated from the example module (\`src/modules/examples\`) by \`pnpm g:module ${plural}\`.\n\n` +
    `Error range: ${base}–${base + 99}. Queue: \`${plural}\`. Replace the example fields (title, body, tags, reminder) with\n` +
    `this resource's own, keep the conventions, and document its rules here.\n`,
);

const e2eSource = join(ROOT, 'test/e2e/notes.e2e-spec.ts');
writes.set(join(ROOT, 'test/e2e', `${plural}.e2e-spec.ts`), transform(readFileSync(e2eSource, 'utf8')));

/** Inserts `line` before the first line containing `marker`. */
function insertBefore(text, marker, line) {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`marker "${marker}" not found`);
  const lineStart = text.lastIndexOf('\n', index) + 1;
  return `${text.slice(0, lineStart)}${line}\n${text.slice(lineStart)}`;
}

function addImport(text, statement) {
  const lastImport = [...text.matchAll(/^import .*;$/gm)].at(-1);
  const end = lastImport.index + lastImport[0].length;
  return `${text.slice(0, end)}\n${statement}${text.slice(end)}`;
}

const edits = [
  ['src/app/api.module.ts', 'g:module api', `${N.Plural}ApiModule`],
  ['src/app/worker.module.ts', 'g:module worker', `${N.Plural}JobsModule`],
  ['src/app/cron.module.ts', 'g:module cron', `${N.Plural}CronModule`],
  ['src/app/socket.module.ts', 'g:module socket', `${N.Plural}RealtimeModule`],
  ['src/app/graphql.module.ts', 'g:module graphql', `${N.Plural}GraphqlModule`],
  ['src/cli/cli.module.ts', 'g:module cli', `${N.Plural}CoreModule`],
];
for (const [file, marker, moduleName] of edits) {
  const path = join(ROOT, file);
  let text = writes.get(path) ?? readFileSync(path, 'utf8');
  text = addImport(text, `import { ${moduleName} } from '@/modules/${plural}/${plural}.module';`);
  text = insertBefore(text, marker, `    ${moduleName},`);
  writes.set(path, text);
}

const constantsPath = join(ROOT, 'src/infra/queue/queue.constants.ts');
writes.set(
  constantsPath,
  readFileSync(constantsPath, 'utf8').replace(
    /\} as const;/,
    `  /** ${N.Plural}: background work of the ${plural} module. */\n  ${N.PLURAL}: '${plural}',\n} as const;`,
  ),
);
const policiesPath = join(ROOT, 'src/infra/queue/queue-policies.ts');
writes.set(
  policiesPath,
  readFileSync(policiesPath, 'utf8').replace(
    /\n\}\);\n\n\/\*\* Policy of a queue/,
    `\n  [QueueName.${N.PLURAL}]: {\n    purpose: '${N.Plural} module: reminders and background work',\n    owner: '${plural}',\n    attempts: 3,\n    backoffMs: 5 * SECOND,\n    concurrency: 5,\n    idempotency: 'conditional claim on the record; Notifier dedupes per occurrence',\n  },\n});\n\n/** Policy of a queue`,
  ),
);

// ── Apply ────────────────────────────────────────────────────────────────────
for (const [path, content] of writes) {
  console.log(`${dryRun ? 'would write' : 'write'}  ${relative(ROOT, path)}`);
  if (dryRun) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
if (!dryRun) {
  // House style on everything written (import order, line breaks), as the pre-commit hook would.
  const files = [...writes.keys()].filter((path) => path.endsWith('.ts')).map((path) => relative(ROOT, path));
  // Prettier first (renamed identifiers change line lengths), then ESLint's fixes on the result.
  execFileSync('pnpm', ['exec', 'prettier', '--write', '--log-level', 'warn', ...files, relative(ROOT, join(target, 'README.md'))], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['exec', 'eslint', '--fix', ...files], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'prettier', '--write', '--log-level', 'warn', ...files], { cwd: ROOT, stdio: 'inherit' });
}
console.log(`
${dryRun ? 'Dry run: nothing written.' : `Module ${plural} created (errors ${base}–${base + 99}, queue ${plural}).`}
Next:
  1. Replace the example fields in schemas/, dto/ and the views with this resource's own.
  2. pnpm lint:fix && pnpm typecheck && pnpm test && E2E_ID=${plural} pnpm test:e2e
  3. pnpm messages:export && pnpm graphql:schema   (generated docs must stay current)
  4. Describe the module's rules in src/modules/${plural}/README.md.`);
