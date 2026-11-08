// Shared by the integration and api global setups (ADR 0001 §6.2, ADR 0002 §8.3):
//   1. refuses to run unless both URLs point at the same database whose name ends in `_test`
//   2. takes the run lock (one connection held for the whole run)
//   3. wipes that database (drizzle, srs_guard and public schemas) and applies every migration
// Never prints URLs: they contain passwords.
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { validateMigrationConfig, validateServerConfig } from '../../../server/utils/env'
import { MIGRATIONS_FOLDER } from './paths'

export function resolveTestDbUrls(): { appUrl: string; migratorUrl: string } {
  try {
    // Local convenience; never overrides variables that are already set (CI sets them directly).
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Validation messages never contain values; only the variable name is added.
  const named = <T>(variable: string, validate: () => T): T => {
    try {
      return validate()
    } catch (error) {
      throw new Error(`${variable}: ${(error as Error).message}`, { cause: error })
    }
  }
  const { databaseUrl: appUrl } = named('TEST_DATABASE_URL', () =>
    validateServerConfig({
      databaseUrl: process.env.TEST_DATABASE_URL,
      built: true, // same TLS rule as a built server for non-local hosts
    }),
  )
  const { migratorUrl } = named('TEST_DATABASE_MIGRATOR_URL', () =>
    validateMigrationConfig({ migratorUrl: process.env.TEST_DATABASE_MIGRATOR_URL }),
  )

  const app = new URL(appUrl)
  const mig = new URL(migratorUrl)
  const dbName = app.pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test') || app.pathname !== mig.pathname || app.host !== mig.host) {
    throw new Error(
      'Refusing to run database tests: TEST_DATABASE_URL and TEST_DATABASE_MIGRATOR_URL must point ' +
        'at the same database, and its name must end in _test (it is wiped on every run).',
    )
  }
  if (app.username === mig.username) {
    throw new Error(
      'Refusing to run database tests: TEST_DATABASE_URL must use the app role, not the migrator.',
    )
  }
  return { appUrl, migratorUrl }
}

/** Session-level advisory lock that serializes runs (integration, api, e2e) against the _test database. */
export const RUN_LOCK_KEY = 4_402_002 // arbitrary, fixed: "LEX-002"

/** Takes the run lock, wipes and migrates the test database. Call the returned function to release. */
export async function prepareTestDatabase(): Promise<{
  appUrl: string
  migratorUrl: string
  release: () => Promise<void>
}> {
  const { appUrl, migratorUrl } = resolveTestDbUrls()
  // One connection, held for the whole run: it owns the advisory lock until release.
  const sql = postgres(migratorUrl, { max: 1, idle_timeout: 0, onnotice: () => {}, connect_timeout: 5 })
  try {
    let locked: boolean
    try {
      const [row] = await sql<
        { locked: boolean }[]
      >`select pg_catalog.pg_try_advisory_lock(${RUN_LOCK_KEY}) as locked`
      locked = row!.locked
    } catch {
      throw new Error('Cannot connect to the test database as the migrator. Is it running? (pnpm db:up)')
    }
    if (!locked) {
      throw new Error(
        'Another test run is using the test database (advisory lock held). ' +
          'Wait for it to finish; runs share one database and wipe it on start.',
      )
    }
    await sql`drop schema if exists drizzle cascade`
    await sql`drop schema if exists srs_guard cascade`
    await sql`drop schema if exists public cascade`
    await sql`create schema public authorization pg_database_owner`
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER })
  } catch (error) {
    await sql.end({ timeout: 5 })
    throw error
  }
  // Closing the session releases the advisory lock.
  return { appUrl, migratorUrl, release: () => sql.end({ timeout: 5 }) }
}
