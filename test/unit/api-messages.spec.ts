import '@/bootstrap/openapi-env';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// Every process module, so every DTO and error catalogue of every process is registered.
import '@/app/socket.module';
import '@/app/worker.module';
import '@/app/cron.module';
import '@/app/graphql.module';
import { createOpenApiDocument, OpenApiBuild } from '@/bootstrap/openapi';
import { loadErrorCatalogues } from '@/common/messages/catalogue-loader';
import { collectMessageCatalogue, MessageCatalogue, renderMessageCatalogue } from '@/common/messages/message-catalogue';
import { messageProblems } from '@/common/messages/message-rules';
import { registeredRules, ruleMessage } from '@/common/pipes/validation-messages';

const ROOT = resolve(__dirname, '..', '..');
const CATALOGUE_FILE = join(ROOT, 'docs/api/messages.md');

/** Success messages that say nothing on their own. */
const EMPTY_SUCCESS = /^(ok|okay|success|successful|done|created|updated|deleted|fetched( successfully)?)\.?$/i;

/**
 * Every message the API shows to people must read as a plain sentence and name no internals
 * (docs/conventions/messages.md). Checks the error registry, the duplicate-value messages,
 * every validation rule of every DTO, every route's success message, the messages written at throw
 * sites, and that the generated catalogue is current.
 */
describe('API messages', () => {
  let build: OpenApiBuild;
  let catalogue: MessageCatalogue;

  beforeAll(async () => {
    const { errors, duplicateKeys } = loadErrorCatalogues();
    build = await createOpenApiDocument();
    catalogue = collectMessageCatalogue(build.document, build.routes, errors, duplicateKeys);
  }, 60_000);

  it('loads every error catalogue', () => {
    expect(catalogue.errors.map((e) => e.key)).toEqual(
      expect.arrayContaining(['INTERNAL_ERROR', 'VALIDATION_FAILED', 'SESSION_REVOKED', 'INTEGRATION_UNAVAILABLE']),
    );
  });

  it('every error message is a plain sentence that names no internals', () => {
    const problems = catalogue.errors.flatMap((error) =>
      messageProblems(error.message, error.key).map((p) => `${error.code} ${error.key}: "${error.message}" ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it('every duplicate-value message is a plain sentence that names no internals', () => {
    const problems = catalogue.duplicateKeys.flatMap((rule) =>
      messageProblems(rule.message).map((p) => `${rule.collection}: "${rule.message}" ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it('every enveloped route declares a short, human success message', () => {
    const problems = catalogue.successes.flatMap((entry) => {
      const route = `${entry.method} ${entry.path}`;
      if (entry.note) return [];
      if (!entry.message) return [`${route}: no @ResponseMessage`];
      const own = EMPTY_SUCCESS.test(entry.message) ? ['says nothing on its own'] : [];
      return [...own, ...messageProblems(entry.message)].map((p) => `${route}: "${entry.message}" ${p}`);
    });
    expect(problems).toEqual([]);
  });

  it('every validation rule of every DTO produces a human message', () => {
    const rules = registeredRules().filter((rule) => typeof rule.target === 'function');
    expect(rules.length).toBeGreaterThan(0);
    const problems = [
      ...new Set(
        rules.flatMap((rule) => {
          const message = ruleMessage(rule);
          const where = `${(rule.target as { name: string }).name}.${rule.propertyName}`;
          return messageProblems(message, where).map((p) => `${where}: "${message}" ${p}`);
        }),
      ),
    ];
    expect(problems).toEqual([]);
  });

  it('messages written at throw sites and in validation details are plain sentences', () => {
    const problems = literalMessages().flatMap(({ where, message }) =>
      messageProblems(message).map((p) => `${where}: "${message}" ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it('docs/api/messages.md is up to date (run `pnpm messages:export`)', () => {
    const current = readFileSync(CATALOGUE_FILE, 'utf8');
    const expected = renderMessageCatalogue(catalogue);
    if (current !== expected) {
      const a = current.split('\n');
      const b = expected.split('\n');
      const line = a.findIndex((text, i) => text !== b[i]);
      throw new Error(
        `docs/api/messages.md is out of date: run \`pnpm messages:export\`. First difference at line ${line + 1}:\n` +
          `  file:     ${a[line] ?? '(end)'}\n  expected: ${b[line] ?? '(end)'}`,
      );
    }
  });
});

/** Files whose `message:` literals are not shown to people (decorator text is rebuilt by the formatter). */
const NOT_PUBLIC = [
  /\.spec\.ts$/,
  /\/dto\//,
  /\.dto\.ts$/,
  /\.errors\.ts$/,
  /^src\/(cli|migrations)\//,
  /^src\/common\/exceptions\/(error-registry|duplicate-keys)\.ts$/,
  /^src\/common\/pipes\/validation-messages\.ts$/,
  /^src\/infra\/health\//,
];

/** Helpers that collect field problems with the message as their last argument. */
const PROBLEM_HELPERS = /\b(fail|problem|invalid|ContentError)\(/;
/** Files whose helpers of those names are not about people's input (boot-time config checks). */
const PROBLEM_HELPERS_IGNORED: RegExp[] = [];

/**
 * Literal messages in source outside decorators and catalogues: `message: '…'` (the messages thrown
 * with domain exceptions and the `details[].message` services build) and the last string argument
 * of field-problem helpers (`fail('title', '…')`). Template placeholders count as a word.
 */
function literalMessages(): Array<{ where: string; message: string }> {
  const src = join(ROOT, 'src');
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => relative(ROOT, join(src, file)))
    .filter((file) => !NOT_PUBLIC.some((pattern) => pattern.test(file)));

  const found: Array<{ where: string; message: string }> = [];
  const clean = (text: string) => text.replace(/\$\{[^}]*\}/g, 'X').replace(/\\(['"`])/g, '$1');
  const messageLiteral = /\bmessage:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  const stringLiteral = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const file of files) {
    const helpers = !PROBLEM_HELPERS_IGNORED.some((pattern) => pattern.test(file));
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/@[A-Z]\w*\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
        const where = `${file}:${index + 1}`;
        for (const match of line.matchAll(messageLiteral)) found.push({ where, message: clean(match[2]) });
        if (helpers && PROBLEM_HELPERS.test(line) && !/\b(function|const|=>)\b.*\(\s*\w+:/.test(line)) {
          const last = [...line.matchAll(stringLiteral)].at(-1);
          // A message has words; skip calls whose last string is a field name.
          if (last && /\s/.test(last[2])) found.push({ where, message: clean(last[2]) });
        }
      });
  }
  return found;
}
