import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Boot-time least-privilege check for the runtime DB role (ADR 0001 D9, architecture §8).
 * A built server must not run with a role that can change the schema or bypass the table grants
 * from migration 0004. Problems are reported as fixed codes and never contain values.
 */
export const DB_ROLE_PROBLEMS = {
  superuser: 'is (or can become) a superuser',
  createRoleOrDb: 'can create roles or databases',
  bypassRls: 'can bypass row-level security',
  replication: 'has the replication attribute',
  writeAllData: 'is a member of pg_write_all_data',
  serverFiles: 'is a member of pg_execute_server_program, pg_read_server_files or pg_write_server_files',
  setReplicationRole: 'can SET session_replication_role (skips every trigger)',
  databaseCreate: 'can create schemas in the database',
  databaseTemp: 'can create temporary tables',
  ownsDatabase: 'owns the database',
  schemaCreate: 'can create objects in a schema',
  ownsSchema: 'owns a schema',
  ownsRelation: 'owns a table, view, sequence or index',
  ownsFunction: 'owns a function',
  truncateOrTrigger: 'has TRUNCATE or TRIGGER on a table',
  guardSchema: 'has USAGE on the srs_guard schema',
  reviewLogsWritable: 'can UPDATE or DELETE srs_review_logs',
  cardsDeletable: 'can DELETE srs_cards',
} as const

export type DbRoleProblem = keyof typeof DB_ROLE_PROBLEMS

type Flags = Record<DbRoleProblem, boolean>

// `pg_has_role(..., 'MEMBER')` includes the role itself and every role it can SET ROLE to, so a
// NOINHERIT role that could switch to an owner is also caught.
const roleQuery = sql`
  select
    exists (select 1 from pg_catalog.pg_roles r
             where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') and r.rolsuper) as "superuser",
    exists (select 1 from pg_catalog.pg_roles r
             where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
               and (r.rolcreaterole or r.rolcreatedb)) as "createRoleOrDb",
    exists (select 1 from pg_catalog.pg_roles r
             where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') and r.rolbypassrls) as "bypassRls",
    exists (select 1 from pg_catalog.pg_roles r
             where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') and r.rolreplication) as "replication",
    pg_catalog.pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') as "writeAllData",
    (pg_catalog.pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')
      or pg_catalog.pg_has_role(current_user, 'pg_read_server_files', 'MEMBER')
      or pg_catalog.pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')) as "serverFiles",
    pg_catalog.has_parameter_privilege('session_replication_role', 'SET') as "setReplicationRole",
    pg_catalog.has_database_privilege(current_database(), 'CREATE') as "databaseCreate",
    pg_catalog.has_database_privilege(current_database(), 'TEMP') as "databaseTemp",
    exists (select 1 from pg_catalog.pg_database d
             where d.datname = current_database()
               and pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER')) as "ownsDatabase",
    exists (select 1 from pg_catalog.pg_namespace n
             where pg_catalog.has_schema_privilege(n.oid, 'CREATE')) as "schemaCreate",
    exists (select 1 from pg_catalog.pg_namespace n
             where pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER')) as "ownsSchema",
    exists (select 1 from pg_catalog.pg_class c
             where pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')) as "ownsRelation",
    exists (select 1 from pg_catalog.pg_proc p
             where pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER')) as "ownsFunction",
    exists (select 1 from pg_catalog.pg_class c
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p')
               and n.nspname not in ('pg_catalog', 'information_schema')
               and (pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')
                    or pg_catalog.has_table_privilege(c.oid, 'TRIGGER'))) as "truncateOrTrigger",
    -- to_regnamespace/to_regclass return null for a missing object: coalesce so that a missing
    -- object is "no privilege" instead of an error. (The app still needs the tables to work.)
    coalesce(pg_catalog.has_schema_privilege(pg_catalog.to_regnamespace('srs_guard'), 'USAGE'), false)
      as "guardSchema",
    coalesce(pg_catalog.has_table_privilege(pg_catalog.to_regclass('public.srs_review_logs'), 'DELETE')
      or pg_catalog.has_any_column_privilege(pg_catalog.to_regclass('public.srs_review_logs'), 'UPDATE'),
      false) as "reviewLogsWritable",
    coalesce(pg_catalog.has_table_privilege(pg_catalog.to_regclass('public.srs_cards'), 'DELETE'), false)
      as "cardsDeletable"
`

/** Returns the privilege problems of the connected role; an empty list means the role is safe. */
export async function findDbRoleProblems<T extends Record<string, unknown>>(
  db: PostgresJsDatabase<T>,
): Promise<DbRoleProblem[]> {
  const [row] = await db.execute<Flags>(roleQuery)
  if (!row) throw new Error('database role check returned no row')
  // Fail closed: anything other than an explicit `false` counts as a problem.
  return (Object.keys(DB_ROLE_PROBLEMS) as DbRoleProblem[]).filter((key) => row[key] !== false)
}

export function describeDbRoleProblems(problems: readonly DbRoleProblem[]): string {
  return problems.map((p) => DB_ROLE_PROBLEMS[p]).join('; ')
}

export interface DbRoleGate {
  /**
   * Resolves true once the role has been verified as safe. Resolves false while verification is
   * impossible (DB unreachable) or after the role was found unsafe. Never rejects.
   */
  ensure(): Promise<boolean>
}

/**
 * Memoizes a successful check. A failed check (DB error) is retried on the next call; an unsafe
 * role calls `onUnsafe` once and stays closed.
 */
export function createDbRoleGate(opts: {
  check: () => Promise<DbRoleProblem[]>
  onUnsafe: (problems: DbRoleProblem[]) => void
}): DbRoleGate {
  let status: 'unknown' | 'safe' | 'unsafe' = 'unknown'
  let inflight: Promise<boolean> | undefined

  const run = async (): Promise<boolean> => {
    try {
      const problems = await opts.check()
      if (problems.length === 0) {
        status = 'safe'
        return true
      }
      status = 'unsafe'
      opts.onUnsafe(problems)
      return false
    } catch {
      return false // unreachable or unexpected: stay closed, retry later. Error details may hold values.
    } finally {
      inflight = undefined
    }
  }

  return {
    ensure() {
      if (status === 'safe') return Promise.resolve(true)
      if (status === 'unsafe') return Promise.resolve(false)
      inflight ??= run()
      return inflight
    },
  }
}
