import { HttpStatus } from '@nestjs/common';
import type { OpenAPIObject, OperationObject, ResponseObject } from '@nestjs/swagger';
import { STAFF_ROLES } from '@/common/auth/auth.types';
import { RESPONSE_MESSAGE_KEY, SKIP_ENVELOPE_KEY } from '@/common/decorators/response.decorators';
import type { ErrorDefinition } from '@/common/exceptions/error-registry';
import { exampleRuleMessages } from '@/common/pipes/validation-messages';
import type { RouteMetadata } from '@/common/swagger/openapi-document';

/** Who reads a message: the client apps, the admin panel, or both. */
export type Audience = 'app' | 'admin' | 'both';

export interface SuccessMessageEntry {
  method: string;
  path: string;
  operationId: string;
  audience: Exclude<Audience, 'both'>;
  /** `undefined` for 204 and raw (non-enveloped) responses, which carry no message. */
  message?: string;
  /** Why there is no message (`no content`, `raw response`). */
  note?: string;
}

export interface ErrorMessageEntry extends ErrorDefinition {
  /** Undefined when no route documents it: background jobs and logs only. */
  audience?: Audience;
}

export interface DuplicateKeyEntry {
  collection: string;
  field?: string;
  message: string;
}

export interface MessageCatalogue {
  errors: ErrorMessageEntry[];
  successes: SuccessMessageEntry[];
  duplicateKeys: DuplicateKeyEntry[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Errors any route can return whatever it declares (outages, timeouts, unknown failures). */
const EVERYWHERE = new Set([
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
  'REDIS_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'ROUTE_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  // Raised by the global error mapper for whatever a route throws (framework errors, unique indexes).
  'UNAUTHENTICATED',
  'BAD_REQUEST',
  'RESOURCE_NOT_FOUND',
  'DUPLICATE_RESOURCE',
]);

function routeAudience(path: string, route: RouteMetadata | undefined): Exclude<Audience, 'both'> {
  if (/\/admin(\/|$)/.test(path)) return 'admin';
  if (route?.roles.length && route.roles.every((role) => STAFF_ROLES.includes(role))) return 'admin';
  return 'app';
}

const merge = (current: Audience | undefined, next: Exclude<Audience, 'both'>): Audience =>
  current === undefined || current === next ? next : 'both';

function metadataOf<T>(key: string, route: RouteMetadata): T | undefined {
  return (
    (Reflect.getMetadata(key, route.target.handler) as T | undefined) ??
    (Reflect.getMetadata(key, route.target.controller) as T | undefined)
  );
}

/** Error keys documented on an operation (examples of its 4xx/5xx responses). */
function documentedErrors(operation: OperationObject): string[] {
  const keys: string[] = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (Number(status) < 400) continue;
    const examples = (response as ResponseObject).content?.['application/json']?.examples ?? {};
    keys.push(...Object.keys(examples));
  }
  return keys;
}

/** Collects every error and success message from the built OpenAPI document and the error catalogues. */
export function collectMessageCatalogue(
  document: OpenAPIObject,
  routes: RouteMetadata[],
  errors: ErrorDefinition[],
  duplicateKeys: readonly DuplicateKeyEntry[],
): MessageCatalogue {
  const byOperationId = new Map(routes.filter((r) => r.operationId).map((r) => [r.operationId!, r]));
  const audiences = new Map<string, Audience>();
  const successes: SuccessMessageEntry[] = [];

  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation?.operationId) continue;
      const route = byOperationId.get(operation.operationId);
      const audience = routeAudience(path, route);
      for (const key of documentedErrors(operation)) audiences.set(key, merge(audiences.get(key), audience));

      const entry: SuccessMessageEntry = {
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        audience,
      };
      if (route && metadataOf<boolean>(SKIP_ENVELOPE_KEY, route)) entry.note = 'raw response (file, stream or probe)';
      else if (route?.successStatus === HttpStatus.NO_CONTENT) entry.note = 'no content (204)';
      else entry.message = route ? metadataOf<string>(RESPONSE_MESSAGE_KEY, route) : undefined;
      successes.push(entry);
    }
  }

  return {
    errors: errors.map((error) => ({
      ...error,
      audience: EVERYWHERE.has(error.key) ? 'both' : audiences.get(error.key),
    })),
    successes: successes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    duplicateKeys: [...duplicateKeys].sort(
      (a, b) => a.collection.localeCompare(b.collection) || (a.field ?? '').localeCompare(b.field ?? ''),
    ),
  };
}

const cell = (text: string | number | undefined) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
const row = (cells: Array<string | number | undefined>) => `| ${cells.map(cell).join(' | ')} |`;
const AUDIENCE_LABEL: Record<Audience, string> = { app: 'App', admin: 'Admin', both: 'App + admin' };

/** Section titles; the key is the catalogue's domain, or `domain:thousand` when a domain spans ranges. */
const SECTION_TITLES: Record<string, string> = {
  auth: 'Sign-in and permissions',
  'auth-access': 'Sessions and access',
  request: 'Requests and validation',
  system: 'System',
  integrations: 'Outside services',
};

const NOT_LISTED = 'Internal';

function sectionTitle(domain: string, thousand: number): string {
  const title = SECTION_TITLES[`${domain}:${thousand}`] ?? SECTION_TITLES[domain] ?? domain.replace(/-/g, ' ');
  return title[0].toUpperCase() + title.slice(1);
}

/** The catalogue as Markdown (`docs/api/messages.md`). Deterministic: no dates, stable order. */
export function renderMessageCatalogue(catalogue: MessageCatalogue): string {
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(
    '# API messages',
    '',
    '<!-- Generated by `pnpm messages:export`; do not edit by hand. test/unit/api-messages.spec.ts fails when it is out of date. -->',
    '',
    'Every message the API shows to people, for review. The admin panel and the app display these texts as they are:',
    '',
    '- **Errors:** `errorMessage` of `{ success: false, errorCode, error, errorMessage, details?, requestId }`. Apps branch on `errorCode` / `error`, which never change; only the wording below is shown.',
    '- **Validation:** `details[].message`, one per field (`details[].field` is the request field, so forms can highlight it); `errorMessage` is that message when there is one problem, otherwise "Please check the highlighted fields."',
    '- **Successes:** `message` of `{ success: true, message, data }`.',
    '',
    'Rules for every message: a plain sentence, the next step when there is one, no internal names (database, cache, job queues, providers, field keys), no technical jargon, no personal data. `test/unit/api-messages.spec.ts` enforces them.',
    '',
    '"Who sees it" comes from the routes that return the error: **Admin** for `/admin` routes and staff-only routes, **App** for the others (the client apps), **App + admin** for both. **Internal** errors are raised inside the server (shared services, background jobs) and are not listed on a route; if one ever reaches a person, this is the text they see.',
    '',
    '## Contents',
    '',
    '- [Validation messages](#validation-messages)',
    '- [Errors](#errors)',
    '- [Duplicate values](#duplicate-values)',
    '- [Success messages](#success-messages)',
    '',
    '## Validation messages',
    '',
    'Built from the rule and the field\'s label (`tagIds` reads "Tags"), so every form reads the same way. Examples:',
    '',
    row(['Rule', 'Example message']),
    row(['---', '---']),
    ...exampleRuleMessages().map(({ rule, example }) => row([rule, example])),
    '',
    '## Errors',
    '',
  );

  // One section per catalogue, split by thousand when a catalogue spans ranges (auth: 1xxx and 3xxx).
  const sections = new Map<string, { domain: string; thousand: number; entries: ErrorMessageEntry[] }>();
  for (const error of catalogue.errors) {
    const thousand = Math.floor(error.code / 1000);
    const key = `${error.domain}:${thousand}`;
    const section = sections.get(key) ?? { domain: error.domain, thousand, entries: [] };
    section.entries.push(error);
    sections.set(key, section);
  }
  const ordered = [...sections.values()].sort((a, b) => a.entries[0].code - b.entries[0].code);
  for (const { domain, thousand, entries } of ordered) {
    const first = entries[0].code;
    const last = entries.at(-1)!.code;
    push(`### ${sectionTitle(domain, thousand)} (${first === last ? first : `${first}–${last}`})`, '');
    push(row(['Code', 'Key', 'HTTP', 'Who sees it', 'Message']), row(['---', '---', '---', '---', '---']));
    for (const error of entries) {
      push(
        row([
          error.code,
          `\`${error.key}\``,
          error.status,
          error.audience ? AUDIENCE_LABEL[error.audience] : NOT_LISTED,
          error.message,
        ]),
      );
    }
    push('');
  }

  push(
    '## Duplicate values',
    '',
    'When two requests save the same unique value at the same moment, the second gets `DUPLICATE_RESOURCE` (2006, HTTP 409) with this message instead of the generic "This already exists. Change it and try again." `details[].field` is set only when the client sent that field.',
    '',
    row(['Field', 'Message']),
    row(['---', '---']),
    ...catalogue.duplicateKeys.map((rule) => row([rule.field ? `\`${rule.field}\`` : '—', rule.message])),
    '',
    '## Success messages',
    '',
  );

  for (const audience of ['app', 'admin'] as const) {
    const entries = catalogue.successes.filter((entry) => entry.audience === audience);
    push(`### ${audience === 'app' ? 'App' : 'Admin'} (${entries.length} routes)`, '');
    push(row(['Method', 'Route', 'Message']), row(['---', '---', '---']));
    for (const entry of entries) {
      push(row([entry.method, `\`${entry.path}\``, entry.message ?? `— (${entry.note ?? 'none'})`]));
    }
    push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
