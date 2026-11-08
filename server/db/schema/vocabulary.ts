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
    // Normalized by shared/answers (LEX-010); used for duplicate detection on create and CSV import.
    normalizedTargetExpression: text('normalized_target_expression').notNull(),
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
    // duplicate lookup: WHERE collection_id = $1 AND normalized_target_expression = ANY($2)
    index('vocabulary_entries_collection_normalized_idx').on(t.collectionId, t.normalizedTargetExpression),
    check('vocabulary_entries_target_len', sql`char_length(${t.targetExpression}) between 1 and 500`),
    check(
      'vocabulary_entries_normalized_target_len',
      sql`char_length(${t.normalizedTargetExpression}) between 1 and 500`,
    ),
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
    // Also serves the answer engine lookup (entry_id, language).
    uniqueIndex('accepted_answers_entry_language_text_key').on(t.entryId, t.language, t.normalizedText),
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
    // One open flag per submitted answer; resolved flags are history.
    uniqueIndex('answer_flags_open_key')
      .on(t.userId, t.entryId, t.direction, t.submittedAnswer)
      .where(sql`${t.status} = 'pending'`),
    index('answer_flags_entry_idx').on(t.entryId),
    check('answer_flags_submitted_len', sql`char_length(${t.submittedAnswer}) between 1 and 500`),
  ],
)

// Synonyms are attached to a meaning or sense (spec US-MCQ-02). Only approved ones are used later.
// Owned through the entry; the language must be one of the collection's pair (trigger, 0003).
export const vocabularySynonyms = pgTable(
  'vocabulary_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    meaningId: uuid('meaning_id'),
    language: text('language').notNull(),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    approvalStatus: approvalStatusEnum('approval_status').notNull().default('pending'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'vocabulary_synonyms_meaning_entry_fk',
      columns: [t.meaningId, t.entryId],
      foreignColumns: [vocabularyMeanings.id, vocabularyMeanings.entryId],
    }).onDelete('cascade'),
    uniqueIndex('vocabulary_synonyms_entry_language_text_key').on(t.entryId, t.language, t.normalizedText),
    index('vocabulary_synonyms_meaning_idx').on(t.meaningId),
    check('vocabulary_synonyms_language_code', sql`${t.language} ~ '^[a-z]{2}$'`),
    check('vocabulary_synonyms_text_len', sql`char_length(${t.text}) between 1 and 500`),
    check('vocabulary_synonyms_normalized_len', sql`char_length(${t.normalizedText}) between 1 and 500`),
  ],
)

/**
 * Curated example sentences (spec §14.1, US-CTX-01). `slots` holds the explicit answer slots as a
 * JSON array of `{ "start": int, "end": int, "answer": string }`: character offsets into `sentence`
 * (end exclusive) and the expected text. One column instead of a child table: slots are only ever
 * read and written together with their sentence. Zod mirrors the format check.
 */
export const sentenceExamples = pgTable(
  'sentence_examples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    meaningId: uuid('meaning_id'),
    language: text('language').notNull(),
    sentence: text('sentence').notNull(),
    translation: text('translation'),
    targetAnswer: text('target_answer').notNull(),
    slots: jsonb('slots').$type<{ start: number; end: number; answer: string }[]>().notNull(),
    approvalStatus: approvalStatusEnum('approval_status').notNull().default('pending'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'sentence_examples_meaning_entry_fk',
      columns: [t.meaningId, t.entryId],
      foreignColumns: [vocabularyMeanings.id, vocabularyMeanings.entryId],
    }).onDelete('cascade'),
    index('sentence_examples_entry_idx').on(t.entryId),
    index('sentence_examples_meaning_idx').on(t.meaningId),
    check('sentence_examples_language_code', sql`${t.language} ~ '^[a-z]{2}$'`),
    check('sentence_examples_sentence_len', sql`char_length(${t.sentence}) between 1 and 1000`),
    check(
      'sentence_examples_translation_len',
      sql`${t.translation} is null or char_length(${t.translation}) between 1 and 1000`,
    ),
    check('sentence_examples_target_answer_len', sql`char_length(${t.targetAnswer}) between 1 and 500`),
    // 1..10 slots; each an object with integer offsets inside the sentence and a non-blank answer.
    check(
      'sentence_examples_slots_format',
      sql`jsonb_typeof(${t.slots}) = 'array' and jsonb_array_length(${t.slots}) between 1 and 10 and octet_length(${t.slots}::text) <= 4096 and not jsonb_path_exists(${t.slots}, '$[*] ? (@.type() != "object" || !(@.start.type() == "number") || !(@.end.type() == "number") || !(@.answer.type() == "string") || @.start != @.start.floor() || @.end != @.end.floor() || @.start < 0 || @.end <= @.start || @.end > $len || @.answer like_regex "^[[:space:]]*$")', jsonb_build_object('len', char_length(${t.sentence})))`,
    ),
  ],
)
