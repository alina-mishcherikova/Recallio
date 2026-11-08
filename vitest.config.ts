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
