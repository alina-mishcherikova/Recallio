import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tsz } from './_shared'
import { users } from './users'

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // Immutable once the collection has entries (trigger, migration 0003).
    nativeLanguage: text('native_language').notNull(),
    targetLanguage: text('target_language').notNull(),
    description: text('description'),
    topic: text('topic'),
    // '{}' = all defaults; the rule shape and defaults are owned by shared/answers (LEX-010).
    normalization: jsonb('normalization').$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: tsz('archived_at'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('collections_owner_created_idx').on(t.ownerId, t.createdAt.desc()),
    check('collections_languages_differ', sql`${t.nativeLanguage} <> ${t.targetLanguage}`),
    check('collections_native_language_code', sql`${t.nativeLanguage} ~ '^[a-z]{2}$'`),
    check('collections_target_language_code', sql`${t.targetLanguage} ~ '^[a-z]{2}$'`),
    check('collections_title_len', sql`char_length(${t.title}) between 1 and 200`),
    check(
      'collections_description_len',
      sql`${t.description} is null or char_length(${t.description}) <= 2000`,
    ),
    check('collections_topic_len', sql`${t.topic} is null or char_length(${t.topic}) between 1 and 100`),
    check(
      'collections_normalization_object',
      sql`jsonb_typeof(${t.normalization}) = 'object' and octet_length(${t.normalization}::text) <= 4096`,
    ),
  ],
)
