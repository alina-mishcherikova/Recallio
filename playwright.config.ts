import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 3100)

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  // Spec US-UI-01: every journey runs on desktop and mobile.
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /rate-limit\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /(security|rate-limit)\.spec\.ts/ },
    // Drains the rate-limit bucket, so it runs after everything else.
    { name: 'rate-limit', testMatch: /rate-limit\.spec\.ts/, dependencies: ['desktop', 'mobile'] },
  ],
  webServer: {
    command: `pnpm build && PORT=${port} node .output/server/index.mjs`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
