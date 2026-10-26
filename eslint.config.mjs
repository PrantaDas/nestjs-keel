import { existsSync, readdirSync } from 'node:fs';
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/*
 * The conventions that must not rot are build failures, not review comments:
 *  - time: no `new Date()` / `Date.now()` / zone math outside src/common/time (docs/conventions/time.md);
 *  - config: no `process.env` outside src/config (and the few files that run before it);
 *  - layers: common ← infra / integrations ← modules, never the other way;
 *  - module boundaries: modules/a never imports modules/b (docs/architecture/microservices.md);
 *  - types: no `any`.
 */

const TIME_HINT = 'Time rule: inject Clock / TimeService from @/common/time (docs/conventions/time.md).';
const LOCAL_DATE_PARTS = [
  'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds', 'getDate', 'getDay', 'getMonth', 'getFullYear',
  'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'setDate', 'setMonth', 'setFullYear',
  'getUTCHours', 'getUTCMinutes', 'getUTCDate', 'getUTCDay', 'getUTCMonth', 'getUTCFullYear',
  'setUTCHours', 'setUTCMinutes', 'setUTCDate', 'setUTCMonth', 'setUTCFullYear',
  'getTimezoneOffset', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleString',
];

const timeImportPaths = ['moment', 'moment-timezone', 'dayjs', 'luxon', 'date-fns', 'date-fns-tz'].map((name) => ({
  name,
  message: TIME_HINT,
}));
const timeImportPatterns = [{ group: ['dayjs/*', 'date-fns/*', '@date-fns/*'], message: TIME_HINT }];

const timeProperties = [
  ...LOCAL_DATE_PARTS.map((property) => ({ property, message: TIME_HINT })),
  { object: 'Date', property: 'now', message: `${TIME_HINT} Use TimeService.now(), or performance.now() for durations.` },
];

const timeSyntax = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: `${TIME_HINT} Call TimeService.now() so time is testable.`,
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>1]",
    message: `${TIME_HINT} new Date(y, m, d) uses the server's zone.`,
  },
];

const envSyntax = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: 'Read configuration through a typed namespace from @/config/configuration (ConfigType), never process.env.',
  },
];

/** Layer rules: what each top-level folder may not import. */
const LAYERS = {
  common: ['@/infra/*', '@/infra/**', '@/integrations/*', '@/integrations/**', '@/modules/*', '@/modules/**', '@/app/*'],
  infra: ['@/modules/*', '@/modules/**', '@/app/*'],
  integrations: ['@/modules/*', '@/modules/**', '@/app/*'],
  modules: ['@/app/*'],
};

const restrictedImports = (extraPatterns = []) => [
  'error',
  { paths: timeImportPaths, patterns: [...timeImportPatterns, ...extraPatterns] },
];

const layerPatterns = (layer) =>
  LAYERS[layer] ? [{ group: LAYERS[layer], message: `${layer}/ must not depend on that layer (docs/architecture/overview.md).` }] : [];

/** modules/<a> may import only its own folder; other modules are reached through @/common/contracts. */
const MODULES = existsSync('src/modules')
  ? readdirSync('src/modules', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

const boundaryPatterns = (own) => {
  const others = MODULES.filter((name) => name !== own);
  if (!others.length) return [];
  const names = others.join('|');
  return [
    {
      regex: `^(@/modules/(${names})(/|$)|(\\.\\./)+(${names})(/|$))`,
      message: `modules/${own} must not import another module: depend on a port in @/common/contracts instead.`,
    },
  ];
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.js', '*.config.mjs', '*.config.cjs', 'scripts/**/*.mjs', 'src/infra/transport/grpc/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // Nest DI needs runtime class imports in constructors; type-only imports would break injection.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Production code: time, config and layer rules.
  ...['common', 'infra', 'integrations', 'modules', 'app', 'bootstrap', 'migrations', 'config', 'cli'].map(
    (layer) => ({
      files: [`src/${layer}/**/*.ts`],
      ignores: ['src/**/*.spec.ts'],
      rules: {
        'no-restricted-imports': restrictedImports(layerPatterns(layer)),
        'no-restricted-properties': ['error', ...timeProperties],
        'no-restricted-syntax': ['error', ...timeSyntax, ...(['config', 'cli'].includes(layer) ? [] : envSyntax)],
      },
    }),
  ),
  ...MODULES.map((name) => ({
    files: [`src/modules/${name}/**/*.ts`],
    ignores: ['src/**/*.spec.ts'],
    rules: { 'no-restricted-imports': restrictedImports([...layerPatterns('modules'), ...boundaryPatterns(name)]) },
  })),
  {
    files: ['src/main.*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...timeSyntax, ...envSyntax] },
  },
  // The time module is the one place that does zone math and reads the system clock.
  {
    files: ['src/common/time/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
  // Run before the config module exists (instrumentation, process TZ, OpenAPI placeholders).
  {
    files: [
      'src/infra/sentry/instrument.ts',
      'src/infra/telemetry/instrument.ts',
      'src/bootstrap/openapi-env.ts',
      'src/bootstrap/openapi.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...timeSyntax] },
  },
  {
    files: ['src/cli/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
