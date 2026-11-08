// API black-box global setup (ADR 0002 §8.3, D9). Runs once per `pnpm test:api`:
//   1. takes the test-database run lock, wipes and migrates recallio_test (shared with integration)
//   2. builds the app if .output is missing or older than the sources (API_REBUILD=1 forces it)
//   3. starts `node .output/server/index.mjs` on a free port with a random NUXT_APP_SECRET,
//      NUXT_APP_ORIGIN, and NUXT_TRUSTED_IP_HEADER=x-test-client-ip, so each test can send its own
//      client IP (separate rate-limit buckets, and no test-only bypass in the app)
//   4. captures stdout and stderr to a file (the tests scan it for leaked secrets and audit lines)
// Never prints URLs or the secret.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { prepareTestDatabase } from '../integration/helpers/test-db'
import { ensureBuild, freePort, startBuiltServer, type StartedServer } from '../helpers/built-server'

declare module 'vitest' {
  export interface ProvidedContext {
    db: { appUrl: string; migratorUrl: string }
    api: { origin: string; logFile: string }
  }
}

export default async function setup(project: TestProject) {
  const db = await prepareTestDatabase()
  let server: StartedServer | undefined
  try {
    ensureBuild(process.env.API_REBUILD === '1')
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const logFile = join(tmpdir(), `recallio-api-${process.pid}-${Date.now()}.log`)
    server = await startBuiltServer({
      port,
      origin,
      host: '127.0.0.1',
      databaseUrl: db.appUrl,
      logFile,
      trustedIpHeader: 'x-test-client-ip',
    })

    project.provide('db', { appUrl: db.appUrl, migratorUrl: db.migratorUrl })
    project.provide('api', { origin, logFile })

    const started = server
    return async () => {
      await started.stop()
      await db.release()
    }
  } catch (error) {
    await server?.stop()
    await db.release()
    throw error
  }
}
