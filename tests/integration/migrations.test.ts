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
      'sentence_examples',
      'srs_cards',
      'srs_review_logs',
      'user_sessions',
      'users',
      'vocabulary_entries',
      'vocabulary_meanings',
      'vocabulary_synonyms',
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

  it('creates the guard and integrity triggers, with only the log check deferred to COMMIT', async () => {
    const rows = await migrator<{ table: string; name: string; deferred: boolean }[]>`
      select c.relname as table, t.tgname as name, (t.tgdeferrable and t.tginitdeferred) as deferred
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
       order by 1, 2`
    expect(rows.map((r) => `${r.table}.${r.name}${r.deferred ? ' (deferred)' : ''}`)).toEqual([
      'accepted_answers.accepted_answers_check_entry_language',
      'answer_change_log.answer_change_log_check_entry_owner',
      'answer_flags.answer_flags_check_entry_owner',
      'collections.collections_languages_immutable',
      'practice_attempts.practice_attempts_check_entry_owner',
      'practice_attempts.practice_attempts_check_entry_revision',
      'sentence_examples.sentence_examples_check_entry_language',
      'srs_cards.srs_cards_check_entry_owner',
      'srs_cards.srs_cards_guard_insert',
      'srs_cards.srs_cards_guard_update',
      'srs_review_logs.srs_review_logs_open_grant',
      'srs_review_logs.srs_review_logs_require_applied (deferred)',
      'vocabulary_entries.vocabulary_entries_lock_collection',
      'vocabulary_synonyms.vocabulary_synonyms_check_entry_language',
    ])
  })

  it('pins search_path on every function and keeps them out of reach of the app role', async () => {
    // Our functions = not part of an extension (citext's functions also live in public).
    const fns = await migrator<{ name: string; definer: boolean; config: string[] | null }[]>`
      select n.nspname || '.' || p.proname as name, p.prosecdef as definer, p.proconfig as config
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'srs_guard')
         and not exists (select 1 from pg_catalog.pg_depend d
                          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       order by 1`
    expect(fns.map((f) => [f.name, f.definer])).toEqual([
      ['public.check_entry_language', false],
      ['public.check_entry_owner', false],
      ['public.check_entry_revision', false],
      ['public.collections_languages_immutable', false],
      ['public.srs_cards_guard_insert', false],
      ['public.srs_cards_guard_update', true],
      ['public.srs_review_logs_open_grant', true],
      ['public.srs_review_logs_require_applied', true],
      ['public.vocabulary_entries_lock_collection', false],
      ['srs_guard.snapshot_matches', false],
    ])
    for (const fn of fns) expect(fn.config, fn.name).toEqual(['search_path=pg_catalog, pg_temp'])

    const executable = await app<{ name: string }[]>`
      select p.proname as name
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'srs_guard')
         and not exists (select 1 from pg_catalog.pg_depend d
                          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
         and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')`
    expect(executable).toEqual([])
  })

  it('the global setup holds the run lock, so a parallel run fails fast (tester M3)', async () => {
    const [row] = await migrator<
      { locked: boolean }[]
    >`select pg_catalog.pg_try_advisory_lock(4402002) as locked`
    if (row!.locked) await migrator`select pg_catalog.pg_advisory_unlock(4402002)`
    expect(row!.locked).toBe(false)
  })

  it('is a no-op when run again', async () => {
    const before = await migrator`select id, hash from drizzle.__drizzle_migrations order by id`
    expect(before).toHaveLength(7)
    await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER })
    const after = await migrator`select id, hash from drizzle.__drizzle_migrations order by id`
    expect(after).toEqual(before)
  })
})
