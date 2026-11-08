// Integration global setup (ADR 0001 §6.2). Runs once per `pnpm test:integration`: takes the run
// lock, wipes `recallio_test` and applies every migration (helpers/test-db.ts). So each run also
// proves the LEX-002 acceptance criterion: migrations apply on an empty database.
import type { TestProject } from 'vitest/node'
import { prepareTestDatabase } from './helpers/test-db'

declare module 'vitest' {
  export interface ProvidedContext {
    db: { appUrl: string; migratorUrl: string }
  }
}

export default async function setup(project: TestProject) {
  const { appUrl, migratorUrl, release } = await prepareTestDatabase()
  project.provide('db', { appUrl, migratorUrl })
  return release
}
