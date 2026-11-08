import { defineConfig, devices } from '@playwright/test'
import { E2E_ORIGIN } from './tests/e2e/env'

export default defineConfig({
  testDir: 'tests/e2e',
  // Migrates recallio_test under the run lock and starts a fresh built server per run (random
  // test secret, fresh rate-limit store). See the file for why this isn't `webServer`.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
  },
  // Spec US-UI-01: every journey runs on desktop and mobile.
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /rate-limit\.spec\.ts/ },
    // 390×844 (CLAUDE.md test plan) on a Chromium mobile profile (touch, isMobile).
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
      testIgnore: /(security|rate-limit)\.spec\.ts/,
    },
    // Drains the rate-limit bucket, so it runs after everything else.
    { name: 'rate-limit', testMatch: /rate-limit\.spec\.ts/, dependencies: ['desktop', 'mobile'] },
  ],
})
