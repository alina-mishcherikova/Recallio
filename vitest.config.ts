import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic (shared/, server/utils, services without Nuxt runtime). Fast, Node env.
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Security regression tests for pure server logic (OWASP abuse cases).
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real PostgreSQL (needs `pnpm db:up`). Not part of `pnpm test`: run `pnpm test:integration`.
        // The global setup rebuilds the _test database from the migrations on every run. Files share
        // one database and commit for real (the SRS guard fires at COMMIT), so they run serially.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      {
        // API black-box tests (ADR 0002 §8.3, D9). Needs `pnpm db:up`; not part of `pnpm test`: run
        // `pnpm test:api`. The global setup migrates recallio_test under the integration run lock,
        // builds if needed, and starts the built server once. Files share that server, so they run
        // serially (the enumeration timing test also needs a quiet server).
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/api/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
      // Components and composables that need the Nuxt runtime.
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          environment: 'nuxt',
        },
      }),
    ],
  },
})
