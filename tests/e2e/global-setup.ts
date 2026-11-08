// Playwright global setup (ADR 0002 §8.4). Runs once per `pnpm test:e2e`, in the runner process:
//   1. takes the test-database run lock, wipes and migrates recallio_test (shared with the
//      integration and api suites, so they never run at the same time; never the dev database)
//   2. builds the app if .output is missing or older than the sources (E2E_REBUILD=1 forces it)
//   3. starts its own built server on E2E_PORT (default 3100) with a random NUXT_APP_SECRET and
//      NUXT_APP_ORIGIN=http://localhost:<port>. A fresh process per run means a fresh in-memory
//      rate-limit store, so repeated local runs never hit "10 registrations per hour" and no
//      app-side test bypass exists. It refuses to start if the port is already taken.
//      NUXT_TRUSTED_IP_HEADER=x-test-client-ip lets each test use its own client IP (env.ts).
//   4. stdout and stderr go to test-results/e2e-server.log (read it when a test fails).
// This replaces Playwright's `webServer`, which starts before globalSetup (it would hit an
// unmigrated database) and would need the secret in the config.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { prepareTestDatabase } from '../integration/helpers/test-db'
import { ROOT, assertNothingListening, ensureBuild, startBuiltServer } from '../helpers/built-server'
import { E2E_IP_HEADER, E2E_ORIGIN, E2E_PORT } from './env'

export default async function globalSetup(_config: FullConfig) {
  await assertNothingListening(E2E_ORIGIN)
  const db = await prepareTestDatabase()
  try {
    ensureBuild(process.env.E2E_REBUILD === '1')
    const dir = join(ROOT, 'test-results')
    mkdirSync(dir, { recursive: true })
    const server = await startBuiltServer({
      port: E2E_PORT,
      origin: E2E_ORIGIN,
      databaseUrl: db.appUrl,
      logFile: join(dir, 'e2e-server.log'),
      // Tests send their own client IP (per-test rate-limit buckets). Requests without it fall back
      // to the socket address, which the rate-limit spec relies on.
      trustedIpHeader: E2E_IP_HEADER,
    })
    return async () => {
      await server.stop()
      await db.release()
    }
  } catch (error) {
    await db.release()
    throw error
  }
}
