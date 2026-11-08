import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tsz } from './_shared'
import { collections } from './collections'
import { answerChangeActionEnum, approvalStatusEnum, directionEnum } from './enums'
import { users } from './users'

// No FK action here ever UPDATEs srs_cards: editing content can't touch scheduling (US-VOC-02).
export const vocabularyEntries = pgTable(
  'vocabulary_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    targetExpression: text('target_expression').notNull(),
    nativeExpression: text('native_expression').notNull(),
    partOfSpeech: text('part_of_speech'),
    topic: text('topic'),
    revision: integer('revision').notNull().default(1),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // keyset pagination: WHERE collection_id = $1 AND (created_at, id) > ($2, $3) ORDER BY created_at, id
    index('vocabulary_entries_collection_page_idx').on(t.collectionId, t.createdAt, t.id),
    check('vocabulary_entries_target_len', sql`char_length(${t.targetExpression}) between 1 and 500`),
    check('vocabulary_entries_native_len', sql`char_length(${t.nativeExpression}) between 1 and 500`),
    check(
      'vocabulary_entries_pos_len',
      sql`${t.partOfSpeech} is null or char_length(${t.partOfSpeech}) between 1 and 50`,
    ),
    check(
      'vocabulary_entries_topic_len',
      sql`${t.topic} is null or char_length(${t.topic}) between 1 and 100`,
    ),
    check('vocabulary_entries_revision_positive', sql`${t.revision} >= 1`),
  ],
)

export const vocabularyMeanings = pgTable(
  'vocabulary_meanings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    definition: text('definition'),
    grammaticalMetadata: jsonb('grammatical_metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('vocabulary_meanings_entry_idx').on(t.entryId),
    unique('vocabulary_meanings_id_entry_key').on(t.id, t.entryId), // target of the composite FK
    check(
      'vocabulary_meanings_definition_len',
      sql`${t.definition} is null or char_length(${t.definition}) between 1 and 2000`,
    ),
    check(
      'vocabulary_meanings_metadata_object',
      sql`jsonb_typeof(${t.grammaticalMetadata}) = 'object' and octet_length(${t.grammaticalMetadata}::text) <= 4096`,
    ),
  ],
)

export const acceptedAnswers = pgTable(
  'accepted_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    meaningId: uuid('meaning_id'),
    language: text('language').notNull(),
    answerText: text('answer_text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [
    // A meaning must belong to the same entry (US-VOC-04). MATCH SIMPLE: skipped when meaning_id is null.
    foreignKey({
      name: 'accepted_answers_meaning_entry_fk',
      columns: [t.meaningId, t.entryId],
      foreignColumns: [vocabularyMeanings.id, vocabularyMeanings.entryId],
    }).onDelete('cascade'),
    index('accepted_answers_entry_language_idx').on(t.entryId, t.language),
    index('accepted_answers_meaning_idx').on(t.meaningId),
    uniqueIndex('accepted_answers_one_primary_idx')
      .on(t.entryId, t.language)
      .where(sql`${t.isPrimary}`),
    check('accepted_answers_language_code', sql`${t.language} ~ '^[a-z]{2}$'`),
    check('accepted_answers_text_len', sql`char_length(${t.answerText}) between 1 and 500`),
    // An empty normalized answer would match empty input: never allowed (CLAUDE.md rule 3).
    check('accepted_answers_normalized_len', sql`char_length(${t.normalizedText}) between 1 and 500`),
  ],
)

/** Append-only for the app role (migration 0004). */
export const answerChangeLog = pgTable(
  'answer_change_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    answerId: uuid('answer_id').notNull(), // soft reference: the log outlives a deleted answer
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: answerChangeActionEnum('action').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('answer_change_log_entry_created_idx').on(t.entryId, t.createdAt),
    index('answer_change_log_user_idx').on(t.userId),
    check(
      'answer_change_log_shape',
      sql`(${t.action} = 'create' and ${t.before} is null and ${t.after} is not null) or (${t.action} = 'update' and ${t.before} is not null and ${t.after} is not null) or (${t.action} = 'delete' and ${t.before} is not null and ${t.after} is null)`,
    ),
    check(
      'answer_change_log_objects',
      sql`(${t.before} is null or jsonb_typeof(${t.before}) = 'object') and (${t.after} is null or jsonb_typeof(${t.after}) = 'object')`,
    ),
  ],
)

export const answerFlags = pgTable(
  'answer_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    direction: directionEnum('direction').notNull(),
    submittedAnswer: text('submitted_answer').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('answer_flags_user_status_created_idx').on(t.userId, t.status, t.createdAt),
    index('answer_flags_entry_idx').on(t.entryId),
    check('answer_flags_submitted_len', sql`char_length(${t.submittedAnswer}) between 1 and 500`),
  ],
)
