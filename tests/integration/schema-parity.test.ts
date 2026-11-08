// Drift between the Drizzle schema and the database actually built from the SQL migrations.
// `pnpm db:generate` compares the schema with meta/*_snapshot.json only, so a hand edit to a .sql file
// (or a snapshot regenerated without its SQL) goes unnoticed there. This compares against the catalog.
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { connectAs, publicTables } from './helpers/db'

const migrator = connectAs('migrator')
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable))

describe('Drizzle schema matches the migrated database', () => {
  it('declares exactly the tables that exist in public', async () => {
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(await publicTables(migrator))
  })

  it.each(tables.map((t) => [getTableName(t), t] as const))(
    '%s: columns, types and nullability',
    async (name, table) => {
      const rows = await migrator<
        { column: string; type: string; not_null: boolean; has_default: boolean }[]
      >`
      select a.attname as column, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null, a.atthasdef as has_default
        from pg_catalog.pg_attribute a
       where a.attrelid = ${`public.${name}`}::regclass and a.attnum > 0 and not a.attisdropped
       order by a.attnum`
      const actual = Object.fromEntries(
        rows.map((r) => [r.column, { type: r.type, notNull: r.not_null, hasDefault: r.has_default }]),
      )
      const expected = Object.fromEntries(
        Object.values(getTableColumns(table)).map((c) => [
          c.name,
          { type: c.getSQLType(), notNull: c.notNull, hasDefault: c.hasDefault },
        ]),
      )
      expect(actual).toEqual(expected)
    },
  )

  it.each(tables.map((t) => [getTableName(t), t] as const))(
    '%s: constraints and indexes by name',
    async (name, table) => {
      const config = getTableConfig(table)
      const constraints = await migrator<{ name: string; type: string; delete_action: string }[]>`
      select conname as name, contype as type, confdeltype as delete_action
        from pg_catalog.pg_constraint
       where conrelid = ${`public.${name}`}::regclass and contype in ('c', 'f', 'u')
       order by 1`
      const byType = (type: string) => constraints.filter((c) => c.type === type).map((c) => c.name)

      expect(byType('c')).toEqual(config.checks.map((c) => c.name).sort())
      expect(byType('u')).toEqual(
        [
          ...config.uniqueConstraints.map((u) => u.getName()),
          ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName!),
        ].sort(),
      )
      const actions: Record<string, string> = {
        a: 'no action',
        r: 'restrict',
        c: 'cascade',
        n: 'set null',
        d: 'set default',
      }
      expect(
        Object.fromEntries(
          constraints.filter((c) => c.type === 'f').map((c) => [c.name, actions[c.delete_action]]),
        ),
      ).toEqual(
        Object.fromEntries(config.foreignKeys.map((fk) => [fk.getName(), fk.onDelete ?? 'no action'])),
      )

      const indexes = await migrator<{ name: string }[]>`
      select i.relname as name
        from pg_catalog.pg_index x
        join pg_catalog.pg_class i on i.oid = x.indexrelid
       where x.indrelid = ${`public.${name}`}::regclass and not x.indisprimary
         and not exists (select 1 from pg_catalog.pg_constraint k where k.conindid = x.indexrelid)
       order by 1`
      expect(indexes.map((i) => i.name)).toEqual(config.indexes.map((i) => i.config.name).sort())
    },
  )
})
