/**
 * E2E tests boot the real app against real MongoDB + Redis (docker compose).
 * They use a separate database and Redis key prefix, so local dev data is untouched.
 */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/test/e2e/setup-env.ts'],
  testTimeout: 30_000,
};
