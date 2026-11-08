// M1/M2 (ADR 0001 §6.7): the global setup applied every migration to an empty database.
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_CHANGE_ACTIONS,
  APPROVAL_STATUSES,
  DIRECTIONS,
  EXERCISE_TYPES,
  PRACTICE_SOURCE_MODES,
  SRS_RATINGS,
  SRS_SCHEDULE_STATUSES,
  SRS_STATES,
} from '../../shared/constants/enums'
import { connectAs, publicTables } from './helpers/db'
import { MIGRATIONS_FOLDER } from './helpers/paths'

const migrator = connectAs('migrator')
const app = connectAs('app')

describe('migrations on an empty database', () => {
  it('creates every MVP table', async () => {
    expect(await publicTables(migrator)).toEqual([
      'accepted_answers',
      'answer_change_log',
      'answer_flags',
      'collections',
      'practice_attempts',
      'srs_cards',
      'srs_review_logs',
      'users',
      'vocabulary_entries',
      'vocabulary_meanings',
    ])
  })

  it('creates the enums with the shared value order', async () => {
    const rows = await migrator<{ name: string; values: string[] }[]>`
      select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder)::text[] as values
        from pg_catalog.pg_type t
        join pg_catalog.pg_enum e on e.enumtypid = t.oid
        join pg_catalog.pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
       group by t.typname`
    expect(Object.fromEntries(rows.map((r) => [r.name, r.values]))).toEqual({
      answer_change_action: [...ANSWER_CHANGE_ACTIONS],
      approval_status: [...APPROVAL_STATUSES],
      direction: [...DIRECTIONS],
      exercise_type: [...EXERCISE_TYPES],
      practice_source_mode: [...PRACTICE_SOURCE_MODES],
      srs_rating: [...SRS_RATINGS],
      srs_schedule_status: [...SRS_SCHEDULE_STATUSES],
      srs_state: [...SRS_STATES],
    })
  })

  it('creates the guard and integrity triggers, with the log check deferred to COMMIT', async () => {
    const rows = await migrator<{ table: string; name: string; deferrable: boolean; deferred: boolean }[]>`
      select c.relname as table, t.tgname as name, t.tgdeferrable as deferrable, t.tginitdeferred as deferred
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
       order by 2`
    expect(rows).toEqual([
      {
        table: 'answer_change_log',
        name: 'answer_change_log_check_entry_owner',
        deferrable: false,
        deferred: false,
      },
      { table: 'answer_flags', name: 'answer_flags_check_entry_owner', deferrable: false, deferred: false },
      { table: 'collections', name: 'collections_languages_immutable', deferrable: false, deferred: false },
      {
        table: 'practice_attempts',
        name: 'practice_attempts_check_entry_owner',
        deferrable: false,
        deferred: false,
      },
      { table: 'srs_cards', name: 'srs_cards_check_entry_owner', deferrable: false, deferred: false },
      { table: 'srs_cards', name: 'srs_cards_guard_insert', deferrable: false, deferred: false },
      { table: 'srs_cards', name: 'srs_cards_guard_update', deferrable: false, deferred: false },
      { table: 'srs_review_logs', name: 'srs_review_logs_open_grant', deferrable: false, deferred: false },
      { table: 'srs_review_logs', name: 'srs_review_logs_require_applied', deferrable: true, deferred: true },
    ])
  })

  it('pins search_path on every trigger function and keeps them out of reach of the app role', async () => {
    const fns = await migrator<{ name: string; definer: boolean; config: string[] | null }[]>`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       order by 1`
    expect(fns.map((f) => [f.name, f.definer])).toEqual([
      ['check_entry_owner', false],
      ['collections_languages_immutable', false],
      ['srs_cards_guard_insert', false],
      ['srs_cards_guard_update', true],
      ['srs_review_logs_open_grant', true],
      ['srs_review_logs_require_applied', true],
    ])
    for (const fn of fns) expect(fn.config, fn.name).toEqual(['search_path=pg_catalog, pg_temp'])

    const executable = await app<{ name: string }[]>`
      select p.proname as name
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')`
    expect(executable).toEqual([])
  })

  it('is a no-op when run again', async () => {
    const before = await migrator`select id, hash from drizzle.__drizzle_migrations order by id`
    expect(before).toHaveLength(5)
    await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER })
    const after = await migrator`select id, hash from drizzle.__drizzle_migrations order by id`
    expect(after).toEqual(before)
  })
})
