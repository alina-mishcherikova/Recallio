// Least-privilege roles (ADR 0001 §4, §6.5). The app role is DML-only and owns nothing.
import { drizzle } from 'drizzle-orm/postgres-js'
import { describe, expect, it } from 'vitest'
import { findDbRoleProblems } from '../../server/utils/db-privileges'
import { connectAs, expectPgError, publicTables } from './helpers/db'

const app = connectAs('app')
const migrator = connectAs('migrator')

// UPDATE is always column-level (security H1): keys, owner/parent columns and created_at never.
const CONTENT = ['SELECT', 'INSERT', 'DELETE']
const APPEND = ['SELECT', 'INSERT']
const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

/** ADR 0001 §4.2. Every table in `public` must be listed: a new table without a decision fails. */
const MATRIX: Record<string, { table: string[]; updateColumns: string[] }> = {
  users: {
    table: CONTENT,
    updateColumns: [
      'email',
      'password_hash',
      'native_language',
      'daily_new_limit',
      'daily_review_limit',
      'timezone',
    ],
  },
  collections: {
    table: CONTENT,
    updateColumns: [
      'title',
      'native_language',
      'target_language',
      'description',
      'topic',
      'normalization',
      'archived_at',
    ],
  },
  vocabulary_entries: {
    table: CONTENT,
    updateColumns: [
      'target_expression',
      'normalized_target_expression',
      'native_expression',
      'part_of_speech',
      'topic',
      'revision',
      'updated_at',
    ],
  },
  vocabulary_meanings: { table: CONTENT, updateColumns: ['definition', 'grammatical_metadata'] },
  accepted_answers: {
    table: CONTENT,
    updateColumns: ['meaning_id', 'language', 'answer_text', 'normalized_text', 'is_primary'],
  },
  answer_flags: { table: CONTENT, updateColumns: ['status'] },
  vocabulary_synonyms: {
    table: CONTENT,
    updateColumns: ['meaning_id', 'language', 'text', 'normalized_text', 'approval_status'],
  },
  sentence_examples: {
    table: CONTENT,
    updateColumns: [
      'meaning_id',
      'language',
      'sentence',
      'translation',
      'target_answer',
      'slots',
      'approval_status',
    ],
  },
  answer_change_log: { table: APPEND, updateColumns: [] },
  practice_attempts: { table: APPEND, updateColumns: [] },
  srs_review_logs: { table: APPEND, updateColumns: [] },
  srs_cards: {
    table: APPEND,
    updateColumns: [
      'state',
      'schedule_status',
      'due_at',
      'stability',
      'stability_fast',
      'difficulty',
      'scheduled_days',
      'learning_steps',
      'reps',
      'lapses',
      'last_review_at',
      'scheduler_version',
    ],
  },
}

/** Columns that tie a row to its owner or parent: never updatable (security H1). */
const NEVER_UPDATABLE = new Set([
  'id',
  'owner_id',
  'collection_id',
  'entry_id',
  'user_id',
  'card_id',
  'created_at',
])

describe('the app role cannot change the schema (R1)', () => {
  it.each([
    ['CREATE TABLE', () => app`create table t (a int)`],
    ['CREATE TABLE in public', () => app`create table public.t (a int)`],
    ['CREATE TEMP TABLE', () => app`create temp table t (a int)`],
    ['CREATE FUNCTION', () => app`create function f() returns int language sql as 'select 1'`],
    ['CREATE SCHEMA', () => app`create schema s`],
    ['CREATE INDEX', () => app`create index users_tmp_idx on users (created_at)`],
    [
      'CREATE TRIGGER',
      () =>
        app`create trigger x before insert on users for each row execute function srs_cards_guard_insert()`,
    ],
    ['DROP TABLE', () => app`drop table users`],
    ['DROP TABLE srs_cards', () => app`drop table srs_cards cascade`],
    ['ALTER TABLE ADD COLUMN', () => app`alter table users add column x int`],
    ['ALTER TABLE DROP CONSTRAINT', () => app`alter table srs_cards drop constraint srs_cards_counters`],
    ['DROP FUNCTION', () => app`drop function srs_cards_guard_update() cascade`],
    ['DROP SCHEMA srs_guard', () => app`drop schema srs_guard cascade`],
    ['ALTER TYPE', () => app`alter type srs_rating add value 'manual'`],
  ])('%s → 42501', async (_label, run) => {
    await expectPgError(run(), { code: '42501' })
  })

  it('a GRANT by the app role is a no-op (it holds no grant option)', async () => {
    const acl = () =>
      migrator`select relacl::text from pg_catalog.pg_class where oid = 'public.users'::regclass`
    const before = await acl()
    await app`grant select on users to public` // Postgres only warns: "no privileges were granted"
    expect(await acl()).toEqual(before)
  })

  it('TRUNCATE is denied on every table (R2)', async () => {
    const tables = await publicTables(migrator)
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      await expectPgError(app`truncate ${app(table)}`, { code: '42501' })
    }
  })
})

describe('history tables are insert-only for the app role (R3)', () => {
  it.each([
    ['DELETE srs_cards', () => app`delete from srs_cards`],
    ['UPDATE srs_review_logs', () => app`update srs_review_logs set rating = 'easy'`],
    ['DELETE srs_review_logs', () => app`delete from srs_review_logs`],
    ['UPDATE practice_attempts', () => app`update practice_attempts set is_correct = true`],
    ['DELETE practice_attempts', () => app`delete from practice_attempts`],
    ['UPDATE answer_change_log', () => app`update answer_change_log set before = null`],
    ['DELETE answer_change_log', () => app`delete from answer_change_log`],
    ['UPDATE srs_cards.updated_at', () => app`update srs_cards set updated_at = now()`],
  ])('%s → 42501', async (_label, run) => {
    await expectPgError(run(), { code: '42501' })
  })
})

describe('privilege matrix (R4)', () => {
  it('lists every table in public', async () => {
    expect(await publicTables(migrator)).toEqual(Object.keys(MATRIX).sort())
  })

  it.each(Object.entries(MATRIX))('%s has exactly the approved privileges', async (table, expected) => {
    const granted: string[] = []
    for (const privilege of ALL_PRIVILEGES) {
      const [row] = await app<{ ok: boolean }[]>`
        select pg_catalog.has_table_privilege(${`public.${table}`}, ${privilege}) as ok`
      if (row!.ok) granted.push(privilege)
    }
    expect(granted).toEqual(expected.table)

    // Column-level grants: only the approved UPDATE columns, nothing else.
    const columns = await app<
      { column: string; select: boolean; insert: boolean; update: boolean; references: boolean }[]
    >`
      select a.attname as column,
             pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'SELECT') as select,
             pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'INSERT') as insert,
             pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'UPDATE') as update,
             pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'REFERENCES') as references
        from pg_catalog.pg_attribute a
       where a.attrelid = ${`public.${table}`}::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped`
    for (const c of columns) {
      expect(c.select, `${table}.${c.column} SELECT`).toBe(expected.table.includes('SELECT'))
      expect(c.insert, `${table}.${c.column} INSERT`).toBe(expected.table.includes('INSERT'))
      expect(c.references, `${table}.${c.column} REFERENCES`).toBe(false)
      expect(c.update, `${table}.${c.column} UPDATE`).toBe(expected.updateColumns.includes(c.column))
      if (NEVER_UPDATABLE.has(c.column)) expect(c.update, `${table}.${c.column}`).toBe(false)
    }
  })

  it('has no privileges on the guard schema or the migrations table (R6)', async () => {
    const [row] = await app<{ guard: boolean; drizzle: boolean }[]>`
      select pg_catalog.has_schema_privilege('srs_guard', 'USAGE') as guard,
             pg_catalog.has_schema_privilege('drizzle', 'USAGE') as drizzle`
    expect(row).toEqual({ guard: false, drizzle: false })
    await expectPgError(app`select * from drizzle.__drizzle_migrations`, { code: '42501' })
  })
})

describe('role attributes (R5)', () => {
  it('is not privileged, does not inherit, and is not a member of the migrator', async () => {
    const [row] = await app`
      select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, r.rolinherit,
             pg_catalog.pg_has_role(current_user, 'recallio_migrator', 'MEMBER') as member_of_migrator,
             (select count(*)::int from pg_catalog.pg_auth_members m where m.member = r.oid) as memberships
        from pg_catalog.pg_roles r where r.rolname = current_user`
    expect(row).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
      rolinherit: false,
      member_of_migrator: false,
      memberships: 0,
    })
    await expectPgError(app`set role recallio_migrator`, { code: '42501' })
  })
})

describe('boot privilege check (R7, D9)', () => {
  it('reports the app role as safe', async () => {
    expect(await findDbRoleProblems(drizzle(app))).toEqual([])
  })

  it('reports the migrator role as unsafe', async () => {
    const problems = await findDbRoleProblems(drizzle(migrator))
    expect(problems).toEqual(
      expect.arrayContaining([
        'ownsDatabase',
        'databaseCreate',
        'schemaCreate',
        'ownsRelation',
        'ownsFunction',
        'guardSchema',
        'reviewLogsWritable',
        'cardsDeletable',
      ]),
    )
  })
})
