import postgres from 'postgres'
import { afterAll, expect, inject } from 'vitest'

/** Anything that runs tagged-template queries: a pool, a transaction, or a savepoint. */
export type Q = postgres.ISql

export type Role = 'app' | 'migrator'

/**
 * A postgres.js pool for one role, closed after the test file. `app` = runtime role (DML only),
 * `migrator` = owner of every object (DDL). Seed through `app` unless a test needs the owner.
 */
export function connectAs(role: Role, options: postgres.Options<Record<string, never>> = {}): postgres.Sql {
  const { appUrl, migratorUrl } = inject('db')
  const sql = postgres(role === 'app' ? appUrl : migratorUrl, {
    max: 4,
    idle_timeout: 5,
    connect_timeout: 5,
    onnotice: () => {},
    ...options,
  })
  afterAll(() => sql.end({ timeout: 5 }))
  return sql
}

/** Every table in `public`, from the catalog: new tables are picked up automatically. */
export async function publicTables(sql: Q): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select c.relname as name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by 1`
  return rows.map((r) => r.name)
}

/** Test isolation: tests commit for real (the guard's deferred check fires at COMMIT). */
export async function truncateAll(migrator: Q): Promise<void> {
  const tables = await publicTables(migrator)
  await migrator`truncate ${migrator(tables)} cascade`
  await migrator`truncate srs_guard.review_grants`
}

/** Awaits a promise that must fail and returns the PostgresError. */
export async function pgError(promise: Promise<unknown>): Promise<postgres.PostgresError> {
  const result = await promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (result.ok) throw new Error('expected a database error, but the query succeeded')
  if (!(result.error instanceof postgres.PostgresError)) {
    throw new Error(`expected a PostgresError, got: ${String(result.error)}`)
  }
  return result.error
}

/** Asserts on SQLSTATE and constraint name, never on message text. */
export async function expectPgError(
  promise: Promise<unknown>,
  expected: { code: string; constraint?: string | RegExp },
): Promise<postgres.PostgresError> {
  const error = await pgError(promise)
  expect(error.code, `${error.code}: ${error.message}`).toBe(expected.code)
  if (expected.constraint !== undefined) {
    if (typeof expected.constraint === 'string') {
      expect(error.constraint_name).toBe(expected.constraint)
    } else {
      expect(error.constraint_name).toMatch(expected.constraint)
    }
  }
  return error
}

export async function count(sql: Q, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`
  return row!.n
}

/**
 * Resolves once at least one backend of the app role is blocked on a lock in this database.
 * Use it instead of a fixed timer before releasing a held transaction, so a concurrency test
 * really exercises the lock wait instead of passing vacuously on a slow machine.
 * Pass an app-role pool: pg_stat_activity hides wait events of other roles from non-superusers.
 */
export async function waitForLockWait(app: Q, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await app<{ n: number }[]>`
      select count(*)::int as n from pg_catalog.pg_stat_activity
       where datname = pg_catalog.current_database() and usename = 'recallio_app'
         and wait_event_type = 'Lock'`
    if (row!.n > 0) return
    if (Date.now() > deadline) throw new Error('no transaction started waiting on a lock in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
