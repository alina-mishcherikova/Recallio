# 0001 — Database schema, SRS guard trigger, and least-privilege roles (LEX-002)

- **Status:** Accepted (2026-11-08). Final decisions in §7: D1 approved · D2 rejected · D3 = (b) · D4 = B ·
  D5–D10 approved. This record describes what was implemented in LEX-002.
- **Date:** 2026-11-08
- **Issue:** LEX-002 (#3), branch `feat/lex-002-database-schema`
- **Inputs:** `docs/spec.md` §4–5, §13–15 · `docs/architecture.md` §4, §5, §8 · `CLAUDE.md` rules 1, 2, 5, 7
- **Verified against:** ts-fsrs 6.0.0 (`node_modules`, runtime probe) and a throwaway Postgres 17.11
  container (trigger, privilege, and cascade behaviour in §3 and §4 was executed, not assumed)

---

## 1. Context

LEX-002 creates every MVP table from architecture §4, the SRS database guard (architecture §5, layer 3),
and a least-privilege runtime role (architecture §8). Issue acceptance criterion: _migrations apply on
an empty DB; constraint and trigger tests pass._ No API routes and no UI are part of this issue.

### 1.1 Scope (stories and criteria this issue serves at the data layer)

| ID            | Criterion supported by the schema                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec §14.1    | All MVP entities (User, Collection, VocabularyEntry, VocabularyMeaning, AcceptedAnswer, SrsCard, SrsReviewLog, PracticeAttempt)                                                                             |
| Spec §14.2    | Cards unique by user/entry/direction · idempotent submission · atomic transition + log · practice cannot modify SRS · ownership · language changes don't invalidate cards · revisions don't corrupt history |
| US-VOC-01     | Title, native and target language required · languages differ · description, topic · archive (`archived_at`)                                                                                                |
| US-VOC-02     | `revision` counter · editing doesn't reset FSRS (no FK action touches `srs_cards`) · no reset path in the MVP (D3)                                                                                          |
| US-VOC-03     | "Importing cannot overwrite existing FSRS history" — card INSERT must be pristine, `ON CONFLICT DO UPDATE` is blocked                                                                                       |
| US-VOC-04     | Answers attached to a meaning of the **same** entry (composite FK) · per-answer language · normalization config · `answer_change_log`                                                                       |
| US-TYP-03     | `answer_flags` (user flags a rejected answer); `normalized_text` can never be empty (no auto-accept of empty input)                                                                                         |
| US-SRS-01     | States new/learning/review/relearning · ratings Again/Hard/Good/Easy · persisted due date and memory state · log with timestamp and rating                                                                  |
| US-SRS-02     | Two independent cards per entry (`direction` in the unique key)                                                                                                                                             |
| US-SRS-03     | Backend enforcement (trigger + grants) · duplicate submissions rejected (`UNIQUE(client_review_id)`)                                                                                                        |
| US-SRS-04     | `daily_new_limit`, `daily_review_limit`, `timezone` on users                                                                                                                                                |
| §15 Privacy   | Account deletion hard-deletes every user-owned row in one statement (cascade chain, §2.3)                                                                                                                   |
| US-ANA (sep.) | FSRS reviews (`srs_review_logs`) and practice (`practice_attempts`) stored separately                                                                                                                       |

### 1.2 What ts-fsrs 6.0.0 actually produces

Architecture §4 was written against the legacy ts-fsrs card. In 6.0.0 the legacy `fsrs()`/`Card` API is
`@deprecated`; the supported API is `DefaultScheduler()`, which defaults to **FSRS-7**. Probe output
(`scheduler.newCard` / `scheduler.review`):

| ts-fsrs field (FSRS-7) | Type / observed values                | Column                             | Note                                                   |
| ---------------------- | ------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `cardId`               | string                                | `id`                               | We pass our UUID in as `cardId`.                       |
| `state`                | `State` 0..3                          | `state` (enum)                     | New/Learning/Review/Relearning                         |
| `scheduleStatus`       | `'new' \| 'learning' \| 'review'`     | `schedule_status` (enum) **new**   | Not derivable from `state` (Relearning → `'learning'`) |
| `dueAt`                | Date                                  | `due_at`                           |                                                        |
| `lastReviewAt`         | Date \| null                          | `last_review_at`                   |                                                        |
| `stability`            | float                                 | `stability`                        |                                                        |
| `stabilityFast`        | float (FSRS-7 only; absent in FSRS-6) | `stability_fast` **new**, nullable | Needed for lossless storage and for `forgettingCurve`  |
| `difficulty`           | float                                 | `difficulty`                       |                                                        |
| `scheduledDays`        | **fractional** float (e.g. `4.7777…`) | `scheduled_days` double            | FSRS-7 uses `fractionalDays: true`                     |
| `learningStep`         | int                                   | `learning_steps`                   | Approved name kept; maps to `learningStep`             |
| `reps`, `lapses`       | int                                   | `reps`, `lapses`                   |                                                        |
| — (`elapsed_days`)     | **does not exist** in ts-fsrs 6       | **dropped** (D1)                   | Derivable from `last_review_at`                        |

The revlog returned by `review()` is the **pre-review card** plus `rating` and `reviewTime`. So
`previous_state` (jsonb snapshot of the pre-review card), `rating`, and `reviewed_at` reconstruct it
exactly, and `next_state` holds the post-review card. The jsonb snapshots make logs lossless across scheduler versions.
`Rating` has `Manual = 0` in addition to Again..Easy. It is **not stored** (D2 rejected): there is no
reset path (D3 = b), so a log row always records a real review. The API is async in 6.0.0
(`await DefaultScheduler()`), and `review()` takes `{ card, grade, now }`.

---

## 2. Contracts

### 2.1 Shared constants and Zod (`shared/`, backend-owned; single source for pgEnums and Zod)

```ts
// shared/constants/languages.ts
export const LANGUAGE_CODES = ['fr', 'en'] as const // launch allow-list (decision #3)
export type LanguageCode = (typeof LANGUAGE_CODES)[number]

// shared/constants/enums.ts — order of SRS_STATES / SRS_RATINGS matches ts-fsrs numeric enums
export const DIRECTIONS = ['recognition', 'production'] as const
export const SRS_STATES = ['new', 'learning', 'review', 'relearning'] as const // State 0..3
export const SRS_SCHEDULE_STATUSES = ['new', 'learning', 'review'] as const
export const SRS_RATINGS = ['again', 'hard', 'good', 'easy'] as const // Rating 1..4 (no Manual, D2)
export const EXERCISE_TYPES = ['typing', 'multiple_choice'] as const // R2/R3 values added by migration
export const PRACTICE_SOURCE_MODES = ['typing', 'multiple_choice', 'difficult_words'] as const
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const // answer_flags now, sentence_examples in R2
export const ANSWER_CHANGE_ACTIONS = ['create', 'update', 'delete'] as const

// shared/constants/languages.ts also exports the schema (D5)
export const languageCodeSchema = z.enum(LANGUAGE_CODES)

// shared/schemas/common.ts (re-exports languageCodeSchema)
export const directionSchema = z.enum(DIRECTIONS)
export const reviewRatingSchema = z.enum(SRS_RATINGS)
// ... one z.enum per tuple above
```

Schema files must import these with **relative paths** (`../../../shared/constants/enums`) because
drizzle-kit loads the schema outside Nuxt and cannot resolve `#shared`.

### 2.2 API routes

None in LEX-002. There is no reset endpoint (D3 = b): `POST /api/review/submit` stays the only SRS write path.

### 2.3 Drizzle tables (`server/db/schema/*.ts`)

Conventions: PKs are `uuid` with `defaultRandom()` (`gen_random_uuid()`; PG17 has no `uuidv7()`).
Timestamps are `timestamptz` (`{ withTimezone: true, mode: 'date' }`). Every FK column has an index (cascade performance).
Text lengths are enforced in the DB too (defence in depth; Zod enforces the same limits).

```ts
// server/db/schema/_shared.ts
import { customType, timestamp } from 'drizzle-orm/pg-core'
import { sql, type AnyColumn } from 'drizzle-orm'
export const citext = customType<{ data: string }>({ dataType: () => 'citext' })
export const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
/** ISO 639-1 shape. The allow-list itself lives in shared/constants/languages.ts (D5). */
export const isLangCode = (c: AnyColumn) => sql`${c} ~ '^[a-z]{2}$'`
```

> CHECK bounds are written as literals inside each `sql` template (for example
> ``sql`char_length(${t.title}) between 1 and 200` ``). DDL can't take bound parameters, and `sql.raw`
> is lint-banned, so there is no generic `len()` helper.

```ts
// server/db/schema/enums.ts
export const directionEnum = pgEnum('direction', DIRECTIONS)
export const srsStateEnum = pgEnum('srs_state', SRS_STATES)
export const srsScheduleStatusEnum = pgEnum('srs_schedule_status', SRS_SCHEDULE_STATUSES)
export const srsRatingEnum = pgEnum('srs_rating', SRS_RATINGS)
export const exerciseTypeEnum = pgEnum('exercise_type', EXERCISE_TYPES)
export const practiceSourceModeEnum = pgEnum('practice_source_mode', PRACTICE_SOURCE_MODES)
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES)
export const answerChangeActionEnum = pgEnum('answer_change_action', ANSWER_CHANGE_ACTIONS)
```

```ts
// server/db/schema/users.ts
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    nativeLanguage: text('native_language').notNull(),
    dailyNewLimit: integer('daily_new_limit').notNull().default(20),
    dailyReviewLimit: integer('daily_review_limit').notNull().default(200),
    timezone: text('timezone').notNull().default('UTC'), // IANA; validated by Zod (Intl)
    createdAt: tsz('created_at').notNull().defaultNow(),
    // deleted_at: dropped, see D6
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_len', sql`char_length(${t.email}) between 3 and 254`),
    check('users_password_hash_len', sql`char_length(${t.passwordHash}) between 1 and 512`),
    check('users_native_language_code', sql`${t.nativeLanguage} ~ '^[a-z]{2}$'`),
    check('users_daily_new_limit_range', sql`${t.dailyNewLimit} between 0 and 1000`),
    check('users_daily_review_limit_range', sql`${t.dailyReviewLimit} between 0 and 10000`),
    check('users_timezone_len', sql`char_length(${t.timezone}) between 1 and 64`),
  ],
)
```

```ts
// server/db/schema/collections.ts
export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    nativeLanguage: text('native_language').notNull(),
    targetLanguage: text('target_language').notNull(),
    description: text('description'),
    topic: text('topic'),
    // '{}' = all defaults; the rule shape and defaults are owned by shared/answers (LEX-010)
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
```

```ts
// server/db/schema/vocabulary.ts
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
    unique('vocabulary_meanings_id_entry_key').on(t.id, t.entryId), // target of composite FK
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
      sql`
    (${t.action} = 'create' and ${t.before} is null and ${t.after} is not null) or
    (${t.action} = 'update' and ${t.before} is not null and ${t.after} is not null) or
    (${t.action} = 'delete' and ${t.before} is not null and ${t.after} is null)`,
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
```

```ts
// server/db/schema/srs.ts — writable ONLY from server/services/srs/** (lint rule, D12)
export const srsCards = pgTable(
  'srs_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(), // = ts-fsrs cardId
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    direction: directionEnum('direction').notNull(),
    state: srsStateEnum('state').notNull().default('new'),
    scheduleStatus: srsScheduleStatusEnum('schedule_status').notNull().default('new'), // D1
    dueAt: tsz('due_at').notNull(),
    stability: doublePrecision('stability').notNull().default(0),
    stabilityFast: doublePrecision('stability_fast'), // D1, FSRS-7 only
    difficulty: doublePrecision('difficulty').notNull().default(0),
    scheduledDays: doublePrecision('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0), // ts-fsrs learningStep
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    lastReviewAt: tsz('last_review_at'),
    schedulerVersion: text('scheduler_version').notNull(), // e.g. 'ts-fsrs@6.0.0/fsrs-7'
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('srs_cards_user_entry_direction_key').on(t.userId, t.entryId, t.direction),
    index('srs_cards_user_due_idx').on(t.userId, t.dueAt), // due queue + due counts
    index('srs_cards_entry_idx').on(t.entryId),
    // `x < 'Infinity'` also rejects NaN (NaN sorts above Infinity in Postgres; `NaN >= 0` is TRUE)
    check('srs_cards_stability_finite', sql`${t.stability} >= 0 and ${t.stability} < 'Infinity'::float8`),
    check(
      'srs_cards_stability_fast_finite',
      sql`${t.stabilityFast} is null or (${t.stabilityFast} >= 0 and ${t.stabilityFast} < 'Infinity'::float8)`,
    ),
    check('srs_cards_difficulty_range', sql`${t.difficulty} >= 0 and ${t.difficulty} <= 10`),
    check(
      'srs_cards_scheduled_days_finite',
      sql`${t.scheduledDays} >= 0 and ${t.scheduledDays} < 'Infinity'::float8`,
    ),
    check(
      'srs_cards_counters',
      sql`${t.learningSteps} >= 0 and ${t.reps} >= 0 and ${t.lapses} >= 0 and ${t.lapses} <= ${t.reps}`,
    ),
    check('srs_cards_scheduler_version_len', sql`char_length(${t.schedulerVersion}) between 1 and 64`),
  ],
)

export const srsReviewLogs = pgTable(
  'srs_review_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => srsCards.id, { onDelete: 'cascade' }),
    clientReviewId: uuid('client_review_id').notNull(),
    rating: srsRatingEnum('rating').notNull(),
    reviewedAt: tsz('reviewed_at').notNull(),
    previousState: jsonb('previous_state').$type<Record<string, unknown>>().notNull(), // full pre-review card
    nextState: jsonb('next_state').$type<Record<string, unknown>>().notNull(), // full post-review card
    previousDueAt: tsz('previous_due_at').notNull(),
    nextDueAt: tsz('next_due_at').notNull(),
    schedulerVersion: text('scheduler_version').notNull(),
  },
  (t) => [
    uniqueIndex('srs_review_logs_client_review_id_key').on(t.clientReviewId),
    index('srs_review_logs_card_reviewed_idx').on(t.cardId, t.reviewedAt),
    check(
      'srs_review_logs_states_objects',
      sql`jsonb_typeof(${t.previousState}) = 'object' and jsonb_typeof(${t.nextState}) = 'object'`,
    ),
    check('srs_review_logs_due_order', sql`${t.nextDueAt} >= ${t.reviewedAt}`),
    check('srs_review_logs_scheduler_version_len', sql`char_length(${t.schedulerVersion}) between 1 and 64`),
  ],
)

/** ts-fsrs DefaultScheduler card key → srs_cards property. A unit test asserts full coverage (§5.1). */
export const FSRS_CARD_FIELD_MAP = {
  cardId: 'id',
  state: 'state',
  scheduleStatus: 'scheduleStatus',
  dueAt: 'dueAt',
  lastReviewAt: 'lastReviewAt',
  stability: 'stability',
  stabilityFast: 'stabilityFast',
  difficulty: 'difficulty',
  scheduledDays: 'scheduledDays',
  learningStep: 'learningSteps',
  reps: 'reps',
  lapses: 'lapses',
} as const
```

```ts
// server/db/schema/practice.ts — append-only, no relation to srs_*
export const practiceAttempts = pgTable(
  'practice_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => vocabularyEntries.id, { onDelete: 'cascade' }),
    exerciseType: exerciseTypeEnum('exercise_type').notNull(),
    direction: directionEnum('direction').notNull(),
    sourceMode: practiceSourceModeEnum('source_mode').notNull(),
    submittedAnswer: text('submitted_answer').notNull(),
    matchedAnswerId: uuid('matched_answer_id').references(() => acceptedAnswers.id, { onDelete: 'set null' }),
    isCorrect: boolean('is_correct').notNull(),
    diff: jsonb('diff').$type<unknown[]>(),
    sessionId: uuid('session_id').notNull(), // client/practice-session id; no table in MVP
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('practice_attempts_user_created_idx').on(t.userId, t.createdAt),
    index('practice_attempts_entry_idx').on(t.entryId),
    index('practice_attempts_matched_answer_idx').on(t.matchedAnswerId),
    check('practice_attempts_submitted_len', sql`char_length(${t.submittedAnswer}) <= 500`),
    // a match implies correct; the reverse can't be required because SET NULL clears the id
    check('practice_attempts_match_implies_correct', sql`${t.matchedAnswerId} is null or ${t.isCorrect}`),
    check('practice_attempts_diff_array', sql`${t.diff} is null or jsonb_typeof(${t.diff}) = 'array'`),
  ],
)
```

**Delete behaviour (GDPR, architecture §8):** `users` → (collections, answer_change_log, answer_flags,
srs_cards, practice_attempts) CASCADE; `collections` → `vocabulary_entries` CASCADE; `vocabulary_entries` →
(meanings, accepted_answers, answer_change_log, answer_flags, srs_cards, practice_attempts) CASCADE;
`vocabulary_meanings` → `accepted_answers` CASCADE (composite FK); `srs_cards` → `srs_review_logs` CASCADE;
`accepted_answers` → `practice_attempts.matched_answer_id` SET NULL. **No FK action ever UPDATEs
`srs_cards`**, so editing content can't touch scheduling (US-VOC-02). `DELETE FROM users WHERE id = $1`
removes everything. Verified in the probe: FK cascade actions run as the **table owner**, so cascades
reach `srs_cards`/`srs_review_logs` even though the app role has no DELETE on them.

---

## 3. SRS guard (architecture §5, layer 3)

### 3.1 Design (D4 = variant B)

A scheduling change to `srs_cards` needs a **grant**, and a grant exists only because a
`srs_review_logs` row was inserted in the same transaction. Grants are rows in a private table,
`srs_guard.review_grants`, keyed by the top-level transaction id (`pg_current_xact_id()`, so
savepoints share it). Only `SECURITY DEFINER` trigger functions read or write that table. The app role
has no privilege on schema `srs_guard`, so it can't forge, read, replay, or clear a grant, and no
setting (`set_config`) has any effect on the guard.

1. `AFTER INSERT ON srs_review_logs` (definer) opens the grant `(log_id, card_id, xact_id)`. It refuses
   if this transaction already has an open grant (`SR003`), so at most one log is pending.
2. `BEFORE UPDATE ON srs_cards` (definer): identity columns never change (`SR005`). If any of the 12
   scheduling columns changes, the transaction's grant must exist (`SR001`) and its log must have
   `card_id = NEW.id`, `previous_due_at = OLD.due_at`, `next_due_at = NEW.due_at`, and
   `scheduler_version = NEW.scheduler_version` (`SR002`). The grant is then **deleted** (one log authorizes
   exactly one update) and `updated_at` is set.
3. `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `srs_review_logs` (definer): **at COMMIT**, a
   log whose grant still exists aborts the transaction (`SR004`). A log can't be stored without its card
   update, autocommit log inserts fail, and `SET CONSTRAINTS ALL IMMEDIATE` fails closed.
4. `BEFORE INSERT ON srs_cards` (invoker, no table access): inserts must be a **pristine new card**
   (`SR006`). Card creation can't write history (US-VOC-03). `ON CONFLICT DO NOTHING` works for idempotent
   creation; `ON CONFLICT DO UPDATE` of scheduling fields hits guard 2 and fails (`SR001`).
5. **DELETE** is not a trigger concern: the app role has no DELETE on `srs_cards` or `srs_review_logs`
   (§4). Cards and logs only disappear through entry, collection, or user cascades.
6. Grant rows never outlive their transaction: commit requires them consumed (3), rollback removes them.
   A grant opened in a rolled-back savepoint is rolled back with its log.

Every function pins `SET search_path = pg_catalog, pg_temp`, references objects schema-qualified, and has
`EXECUTE` revoked from `PUBLIC` (a trigger doesn't need `EXECUTE` to fire, verified by the tests).

Custom SQLSTATEs (class `SR`, unused by Postgres) let tests assert exact failures. The review service
maps them to a 500 response, because they always indicate a bug, never a user error.

| Code    | Meaning                                               |
| ------- | ----------------------------------------------------- |
| `SR001` | scheduling update without a pending review log        |
| `SR002` | update doesn't match the pending log                  |
| `SR003` | second review log inserted while one is still pending |
| `SR004` | review log committed without its card update          |
| `SR005` | card identity columns are immutable                   |
| `SR006` | card insert is not a pristine new card                |

### 3.2 SQL

`server/db/migrations/0002_srs_guard.sql` (custom migration, statements separated with
`--> statement-breakpoint`) is the source of truth.

### 3.3 Review submission with the guard (LEX-009 contract)

```
BEGIN                                            -- top-level db.transaction()
  SELECT … FROM srs_cards WHERE id = $card AND user_id = $session FOR UPDATE
  SELECT … FROM srs_review_logs l JOIN srs_cards c ON c.id = l.card_id
    WHERE l.client_review_id = $crid AND c.user_id = $session          -- replay lookup is owner-scoped
  INSERT INTO srs_review_logs (…)                -- opens grant
  UPDATE srs_cards SET …next                     -- consumes grant
COMMIT                                           -- deferred check passes
```

Rules for the service: insert the log **before** the card update, process one card per transaction, and
never use `SET CONSTRAINTS … IMMEDIATE`. Any other order fails closed.

### 3.4 Practice and other modes

Practice, test, and guided code can't reference the SRS tables (lint rule, D12). Even if it reached the
database, it could only open a grant by inserting a `srs_review_logs` row, and the deferred check would
then require the matching card update in the same transaction. A plain `UPDATE srs_cards` from any
other code path fails with `SR001`.

### 3.5 No reset path (D3 = b)

There is no reset endpoint, no reset function, and no `manual` rating. When a user changes an entry so
much that its meaning is materially different, the UI offers the "new entry" action (spec US-VOC-02): a
new entry gets new pristine cards, and the old entry's history stays intact. `POST /api/review/submit`
remains the only SRS write path, and CLAUDE.md rule 1 is unchanged.

### 3.6 Residual risk

Variant A's deliberate-bypass risk (clearing a transaction setting after inserting a log) does not exist
in variant B: the app role can't touch `srs_guard`. What remains is that the database can't verify FSRS
math: code in the SRS module can log and apply any transition that is consistent with its own log. That
is the intended trust boundary (layer 1: only `review.service.ts` writes, enforced by lint and review).

## 4. Least-privilege roles

### 4.1 Roles

| Role                | Attributes                                                                        | Purpose                                                   |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `recallio_migrator` | LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, **database owner**                  | Runs migrations; owns all tables, types, and functions    |
| `recallio_app`      | LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOINHERIT, not a member of any role | Runtime (Nitro) connection; DML only                      |
| `$POSTGRES_USER`    | Docker superuser                                                                  | Local bootstrap only; never used by the app or migrations |

Roles are **provisioned outside migrations**: by the Docker init script locally and by the hosting
provider in production (LEX-017). Migrations contain no passwords and no `CREATE ROLE`. They only
`GRANT` to `recallio_app` and **fail loudly if the role doesn't exist**.

### 4.2 Privilege matrix for `recallio_app` (custom migration `0004_app_role_grants.sql`)

| Table                                                                                       | Privileges                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| users, collections, vocabulary_entries, vocabulary_meanings, accepted_answers, answer_flags | SELECT, INSERT, UPDATE, DELETE                                         |
| answer_change_log, practice_attempts, srs_review_logs                                       | SELECT, INSERT (append-only)                                           |
| srs_cards                                                                                   | SELECT, INSERT, UPDATE **(the 12 scheduling columns only)**; no DELETE |
| `drizzle.*`, `srs_guard.*`, trigger functions                                               | none                                                                   |

No TRUNCATE, REFERENCES, or TRIGGER privileges anywhere. No CREATE on any schema. No ownership of
anything. Column-level UPDATE on `srs_cards` also makes `user_id/entry_id/direction` unwritable by
privilege, before the trigger even runs. `SELECT … FOR UPDATE` works because the role has UPDATE on at
least one column.

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recallio_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, collections, vocabulary_entries, vocabulary_meanings,
  accepted_answers, answer_flags TO recallio_app;
GRANT SELECT, INSERT ON answer_change_log, practice_attempts, srs_review_logs, srs_cards TO recallio_app;
GRANT UPDATE (state, schedule_status, due_at, stability, stability_fast, difficulty, scheduled_days,
  learning_steps, reps, lapses, last_review_at, scheduler_version) ON srs_cards TO recallio_app;
-- updated_at is set by the guard trigger, so the app role can't write it.
```

No `ALTER DEFAULT PRIVILEGES`: every new table needs an explicit grant in its own migration. The
privilege-matrix test (§5.4) fails on any table missing from the matrix.

### 4.3 Local setup

- `docker/postgres/initdb/10-roles.sh` is mounted read-only at `/docker-entrypoint-initdb.d/`. It runs only on an
  empty volume and does the following. It uses `psql -v ON_ERROR_STOP=1` and reads passwords inside psql
  with `\getenv`, bound as psql variables (`:'app_pw'`): never interpolated by the shell, never on a command line.
  1. Creates both roles with passwords from `RECALLIO_MIGRATOR_PASSWORD` / `RECALLIO_APP_PASSWORD`.
  2. Runs `ALTER DATABASE "$POSTGRES_DB" OWNER TO recallio_migrator` and `CREATE DATABASE recallio_test OWNER recallio_migrator`.
  3. On each DB: `REVOKE ALL ON DATABASE … FROM PUBLIC; GRANT CONNECT … TO recallio_app` (this also removes TEMP).
- Since PG15, `public` is owned by `pg_database_owner`, so the migrator owns it and can create
  `citext`, a trusted extension (migration `0000`).
- `compose.yaml`: add the volume mount, plus `RECALLIO_MIGRATOR_PASSWORD: ${RECALLIO_MIGRATOR_PASSWORD:?set in .env}` and the app equivalent.
  The healthcheck uses TCP (`pg_isready -h 127.0.0.1`), so `docker compose up --wait` returns only after the init script finished.
- **Existing local volumes must be recreated** (`pnpm db:reset` = `docker compose down -v && pnpm db:up && pnpm db:migrate`).
  The LEX-001 volume ran `0000` as the superuser, so the migrator can't write its migrations table.

### 4.4 Env and config

```dotenv
# .env.example
POSTGRES_USER=postgres                       # docker bootstrap superuser, local only
POSTGRES_PASSWORD=change-me-locally
POSTGRES_DB=recallio
POSTGRES_PORT=5432
RECALLIO_MIGRATOR_PASSWORD=change-me-locally-migrator
RECALLIO_APP_PASSWORD=change-me-locally-app
NUXT_DATABASE_URL=postgres://recallio_app:change-me-locally-app@localhost:5432/recallio                 # runtime
DATABASE_MIGRATOR_URL=postgres://recallio_migrator:change-me-locally-migrator@localhost:5432/recallio   # drizzle-kit only
TEST_DATABASE_URL=postgres://recallio_app:change-me-locally-app@localhost:5432/recallio_test
TEST_DATABASE_MIGRATOR_URL=postgres://recallio_migrator:change-me-locally-migrator@localhost:5432/recallio_test
```

- **Runtime** keeps reading only `runtimeConfig.databaseUrl` (`NUXT_DATABASE_URL`, now the app role).
  `DATABASE_MIGRATOR_URL` has no `NUXT_` prefix and is never referenced in `nuxt.config.ts`, so it can't
  reach the server bundle or runtime config.
- **`server/utils/env.ts`:** extract the URL and TLS rule into an exported `databaseUrlSchema`/`checkDatabaseUrl(url, { requireTlsIfRemote })`.
  Add `validateMigrationConfig({ migratorUrl })`, which always applies the `verify-full` rule to
  non-loopback hosts (migrations against a remote DB must verify TLS, whether or not a server is built).
  Messages still never echo values.
- **`drizzle.config.ts`:** read `DATABASE_MIGRATOR_URL` through `validateMigrationConfig` (relative
  import; the file only depends on zod). It loads `.env` when present (never overriding set variables).
  `generate`/`check` don't need a database URL, so the drift check runs without one.
- **Boot privilege check (D9):** `server/utils/db-privileges.ts` (`findDbRoleProblems`) checks, for the
  current role and every role it can `SET ROLE` to: superuser, CREATEROLE/CREATEDB, BYPASSRLS,
  REPLICATION, membership in `pg_write_all_data`, CREATE or TEMP on the database, CREATE on any schema,
  ownership of the database, a schema, a relation, or a function, and TRUNCATE/TRIGGER on any table.
  - `server/plugins/02.db-privileges.ts` runs the check at boot. A **built** server with any problem logs
    the problem descriptions (fixed strings, never values) and exits with code 1. The dev server only warns.
  - `server/middleware/00.db-role.ts` keeps a built server **closed** (503) until the check has passed,
    which covers a database that is unreachable at boot; the check is retried on the next request.
    `/api/health` is exempt so it can still report `degraded`. (A middleware is needed: Nitro ignores
    errors thrown from `request` hooks.)

---

## 5. Migration strategy

| File                          | How                                              | Content                                                       |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `0000_init.sql`               | exists                                           | `citext`                                                      |
| `0001_<generated>.sql`        | `pnpm db:generate`                               | enums, tables, FKs, CHECKs, indexes (from `server/db/schema`) |
| `0002_srs_guard.sql`          | `drizzle-kit generate --custom --name srs_guard` | §3.2                                                          |
| `0003_integrity_triggers.sql` | custom (only if D7 is approved)                  | owner-consistency + collection-language immutability          |
| `0004_app_role_grants.sql`    | custom                                           | §4.2 (last, so it covers every table)                         |

- Custom files are registered in `meta/_journal.json` by drizzle-kit and are invisible to the snapshot,
  so later `generate` runs never try to drop triggers or grants. Separate each statement, and keep each
  `CREATE FUNCTION` body whole, with `--> statement-breakpoint`.
- The drizzle migrator applies all pending migrations in **one transaction**. Consequence: a future
  `ALTER TYPE … ADD VALUE` can't be _used_ by a later migration in the same batch. Put the use in the next release.
- Merged migrations are never edited (architecture §8 A08). Changes ship as new migrations.
- **Drift check** (CI, LEX-017): `pnpm db:generate` must produce no new files (`git diff --exit-code server/db/migrations`).
- `package.json` scripts: `db:migrate` stays on drizzle-kit (uses `DATABASE_MIGRATOR_URL`). Add
  `db:reset` and `test:integration`. `test` runs only the `unit`, `security`, and `nuxt` projects, so it
  (and `pnpm check`) works without Docker.

---

## 6. Test plan

### 6.1 Unit (`tests/unit`, no DB)

| #   | Case                                                                                                                                                                                                                                                                               | Covers               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| U1  | `SRS_STATES[i]` ↔ ts-fsrs `State` numeric values; `SRS_RATINGS[i]` ↔ `Rating` i+1 (Again=1 … Easy=4)                                                                                                                                                                               | US-SRS-01            |
| U2  | **Lossless mapping:** for `DefaultScheduler()` (FSRS-7) and `{ version: 'FSRS-6' }`, every key of `newCard()` and `review().card` is in `FSRS_CARD_FIELD_MAP`, and every mapped value is a column of `srsCards` (`getTableColumns`). Fails on a ts-fsrs upgrade that adds a field. | US-SRS-01, §14.1     |
| U3  | `languageCodeSchema` accepts `fr`, `en`; rejects `de`, `FR`, `fra`, `''`                                                                                                                                                                                                           | DEC-001, decision #3 |
| U4  | `validateMigrationConfig`: loopback OK without TLS; remote requires exactly one `sslmode=verify-full`; errors never contain the URL                                                                                                                                                | §8 A02/A04           |
| U5  | `reviewRatingSchema` rejects `manual`                                                                                                                                                                                                                                              | US-SRS-01            |

### 6.2 Integration project setup

- New Vitest project `integration`: `include: ['tests/integration/**/*.test.ts']`, `environment: 'node'`,
  `globalSetup: 'tests/integration/global-setup.ts'`, files run serially (`fileParallelism: false`, or
  the Vitest 5 per-project equivalent; the tester verifies this).
- **global-setup** (migrator URL):
  1. Refuse to run unless both test URLs point at a database whose name ends in `_test`.
  2. `DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
  3. `migrate()` from `drizzle-orm/postgres-js/migrator`.

  Every run therefore proves the issue's criterion that migrations apply on an empty DB.

- **Helpers** (`tests/integration/helpers/`):
  - `asApp()` / `asMigrator()`: postgres.js clients for the two roles.
  - `factories.ts`: `createUser`, `createCollection`, `createEntry` (with meaning, answers, and 2 pristine cards), `reviewCard(tx, card, next)`, which mimics the §3.3 order.
  - `expectPgError(p, { code, constraint? })`: asserts on SQLSTATE and constraint name, never on message text.
- **Isolation:** `beforeEach` runs `TRUNCATE` on all `public` tables `CASCADE` (as migrator). Tests
  commit for real, because the deferred trigger only fires at COMMIT, so rollback-per-test can't be used.
- Requires `pnpm db:up`. CI uses a Postgres 17 service container and the same init script (LEX-017).

### 6.3 Constraints (`schema.constraints.test.ts`, as **app** role)

| #   | Case                                                                                                                                               | Expect                                     | Covers            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------- |
| C1  | second card same (user, entry, direction) → error; other direction → OK                                                                            | 23505 `srs_cards_user_entry_direction_key` | §14.2, US-SRS-02  |
| C2  | two logs with same `client_review_id` (sequential, and concurrent on two connections)                                                              | 23505                                      | US-SRS-03         |
| C3  | collection with `native_language = target_language`                                                                                                | 23514 `collections_languages_differ`       | US-VOC-01         |
| C4  | language `EN`, `fra`, `''` on users/collections/accepted_answers                                                                                   | 23514 `*_code`                             | DEC-001           |
| C4b | language `de`: DB accepts (format only), `languageCodeSchema` rejects (U3). If D5 = alternative, DB rejects with 23514                             | —                                          | decision #3       |
| C5  | `users.email` `A@x.fr` vs `a@x.fr`                                                                                                                 | 23505 (citext)                             | US-AUTH-01        |
| C6  | accepted answer whose `meaning_id` belongs to another entry                                                                                        | 23503 `accepted_answers_meaning_entry_fk`  | US-VOC-04         |
| C7  | two primary answers for same (entry, language)                                                                                                     | 23505                                      | US-VOC-04         |
| C8  | `normalized_text = ''`                                                                                                                             | 23514                                      | rule 3, US-TYP-03 |
| C9  | `stability` = `NaN`, `Infinity`, `-1`; `difficulty = 11`; `lapses > reps` (inserted as migrator with trigger-valid flow, or via a reviewed update) | 23514                                      | §14.2             |
| C10 | log with `next_due_at < reviewed_at`                                                                                                               | 23514                                      | §14.2             |
| C11 | attempt with `matched_answer_id` set and `is_correct = false`                                                                                      | 23514                                      | rule 3            |
| C12 | `answer_change_log` action/before/after mismatches (each of 3 actions)                                                                             | 23514                                      | US-VOC-04         |
| C13 | `daily_new_limit = -1` / `1001`; `daily_review_limit = 10001`                                                                                      | 23514                                      | US-SRS-04         |
| C14 | non-object `normalization`, `grammatical_metadata`, `previous_state`; non-array `diff`                                                             | 23514                                      | —                 |
| C15 | unknown enum value (`direction = 'both'`, `rating = 'perfect'`)                                                                                    | 22P02                                      | —                 |
| C16 | (D7) changing collection languages after an entry exists                                                                                           | `RC002`                                    | DEC-001, §14.2    |
| C17 | (D7) card/attempt/flag for user B on user A's entry                                                                                                | `RC001`                                    | rule 5            |

### 6.4 SRS guard (`srs-guard.test.ts`, as **app** role)

| #   | Case                                                                                                               | Expect          |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------- |
| G1  | UPDATE any scheduling column without a log (each of the 12 columns, parameterized)                                 | `SR001`         |
| G2  | Review tx: insert log + matching update → commit; card has new values; `updated_at` advanced                       | OK              |
| G3  | Insert log, no card update, COMMIT → fails; log row not persisted                                                  | `SR004`         |
| G4  | Autocommit log insert                                                                                              | `SR004`         |
| G5  | Log for card A, update card B                                                                                      | `SR002`         |
| G6  | Update whose `due_at` / `scheduler_version` differs from the log, or whose OLD `due_at` ≠ `previous_due_at`        | `SR002`         |
| G7  | One log, two updates in the same tx → second fails                                                                 | `SR001`         |
| G8  | Two log inserts before any update                                                                                  | `SR003`         |
| G9  | Pristine card INSERT → OK; INSERT with `reps=1` / `state='review'` / `last_review_at` set / `stability=1`          | `SR006`         |
| G10 | `INSERT … ON CONFLICT DO NOTHING` duplicate → OK, card unchanged; `ON CONFLICT DO UPDATE SET due_at`               | `SR001`         |
| G11 | Rating `manual` is not a valid `srs_rating` (D2 rejected)                                                          | 22P02           |
| G12 | Review inside a released savepoint → OK. Log-only insert in a rolled-back savepoint, then COMMIT → OK, no log      | OK              |
| G13 | App UPDATE of `user_id`/`entry_id`/`direction` → 42501. Same as migrator → `SR005`                                 | 42501 / `SR005` |
| G14 | No-op update (same values) → OK, no grant needed                                                                   | OK              |
| G15 | App can't INSERT/SELECT/DELETE `srs_guard.review_grants` or call the trigger functions; `set_config` has no effect | 42501 / `SR001` |
| G16 | App: `SET session_replication_role = replica` / `ALTER TABLE srs_cards DISABLE TRIGGER …`                          | 42501           |

### 6.5 Roles (`roles.test.ts`)

| #   | Case                                                                                                                                                               | Expect |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| R1  | App: `CREATE TABLE`, `CREATE TEMP TABLE`, `CREATE FUNCTION`, `CREATE SCHEMA`, `DROP TABLE users`, `ALTER TABLE users ADD COLUMN x int`, `CREATE INDEX`             | 42501  |
| R2  | App: `TRUNCATE` on **every** table in `public` (parameterized from the catalog)                                                                                    | 42501  |
| R3  | App: `DELETE FROM srs_cards`, `UPDATE/DELETE srs_review_logs`, `UPDATE/DELETE practice_attempts`, `UPDATE/DELETE answer_change_log`                                | 42501  |
| R4  | **Privilege matrix:** `has_table_privilege` / `has_column_privilege` for every table and privilege equals §4.2 exactly. Any catalog table not in the matrix fails. | equal  |
| R5  | App role attributes: not superuser / createrole / createdb / bypassrls; owns no objects; not a member of `recallio_migrator`; `SET ROLE recallio_migrator` fails   | —      |
| R6  | App can't read `drizzle.__drizzle_migrations`                                                                                                                      | 42501  |
| R7  | (D9) the boot privilege check returns "unsafe" for the migrator URL and "safe" for the app URL                                                                     | —      |

### 6.6 Cascades (`cascade.test.ts`, deletes run as **app** role)

| #   | Case                                                                                                                                                                                                              | Covers        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| X1  | Seed one user with **at least one row in every `public` table** (the test fails if any catalog table is left unseeded). Then `DELETE FROM users` → every table has 0 rows, and a second user's data is untouched. | GDPR §8, §15  |
| X2  | Delete collection → its entries, meanings, answers, change log, flags, cards, review logs, and attempts are gone; other collection intact                                                                         | US-VOC-01     |
| X3  | Delete entry as app → cards + logs gone (app has no DELETE on srs tables; cascade runs as owner)                                                                                                                  | §4.2          |
| X4  | Delete accepted answer → attempt kept with `matched_answer_id = null`; change log kept                                                                                                                            | §14.2 history |
| X5  | Delete meaning → its accepted answers gone, entry intact                                                                                                                                                          | US-VOC-04     |
| X6  | Updating an entry (text, `revision + 1`) leaves both cards byte-identical                                                                                                                                         | US-VOC-02     |

### 6.7 Migrations (`migrations.test.ts`)

- M1: after global setup, the catalog lists the expected tables, enums (with value order), triggers, and the deferred constraint trigger.
- M2: running `migrate()` a second time is a no-op.
- M3 (CI script): no schema drift (§5).

**E2E:** none. LEX-002 has no UI. The practice-mode "SRS unchanged" regression tests (rule 1) are owned by LEX-011/012 and use these helpers.

---

## 7. Decisions (final outcome in the last column)

D1 and D5–D10 were approved as recommended. D2 was rejected, D3 = (b), D4 = B.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                             | Outcome                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| D1  | **Schema additions/removals for ts-fsrs 6 (FSRS-7) losslessness:** add `srs_cards.stability_fast` (nullable double) and `srs_cards.schedule_status` (enum new/learning/review). Drop `srs_cards.elapsed_days` (gone in ts-fsrs 6; derivable from `last_review_at`). Store `scheduled_days` as double (fractional in FSRS-7). Target the non-deprecated `DefaultScheduler` API, FSRS-7, `scheduler_version = 'ts-fsrs@6.0.0/fsrs-7'`. | **Approved.** Required by US-SRS-01 ("persists … memory state"); without `stability_fast`, FSRS-7 state is lost. |
| D2  | Add `manual` to the `srs_rating` enum (ts-fsrs `Rating.Manual`) for reset logs.                                                                                                                                                                                                                                                                                                                                                      | **Rejected.** There is no reset path (D3), so no `manual` rating is stored.                                      |
| D3  | **Reset endpoint.** CLAUDE.md rule 1 says SRS writes happen "only through `POST /api/review/submit`". A reset (US-VOC-02) needs a second entry point into `review.service.ts`. Options: (a) add `POST /api/review/reset` in the srs module and amend rule 1 and architecture §5 layer 2 to name both routes; (b) MVP offers only the "new-entry action" the spec also allows, and reset is deferred. The DB design supports both.    | **Decided: (b).** No reset endpoint; a materially different meaning is a new entry. Rule 1 unchanged.            |
| D4  | **Guard variant.** A: transaction-local `app.review_id` set by DB triggers (§3, matches approved architecture; residual deliberate-bypass risk §3.6). B: same flow, but the grant is a row in a private `srs_review_grants` table written by `SECURITY DEFINER` functions the app role can't touch. B closes §3.6 at the cost of one internal table and definer functions with a pinned `search_path`.                               | **Decided: B** (§3). The app role can't write the grants table or forge a grant.                                 |
| D5  | **Language allow-list in the DB:** format-only CHECK `^[a-z]{2}$` plus a Zod allow-list (adding a language stays a code-only change, as architecture §4 promises), vs `CHECK IN ('fr','en')` (stricter; each new language needs a one-line migration).                                                                                                                                                                               | **Approved: format CHECK + Zod.**                                                                                |
| D6  | **Drop `users.deleted_at`.** Account deletion is a hard delete (architecture §8), so the column would be dead and invites accidental soft-delete retention.                                                                                                                                                                                                                                                                          | **Approved: dropped.**                                                                                           |
| D7  | **Extra integrity triggers (`0003`):** (a) BEFORE INSERT on `srs_cards`, `practice_attempts`, `answer_flags`, `answer_change_log` checks that `user_id` owns the entry's collection (`RC001`; rule 5 defence in depth). (b) collection `native_language`/`target_language` immutable once entries exist (`RC002`; DEC-001, spec §14.2).                                                                                              | **Approved (both).** Both are cheap, and each enforces a stated rule.                                            |
| D8  | **Role model:** `recallio_migrator` (DB owner) + `recallio_app` (DML only), provisioned outside migrations; migrations only GRANT; separate `recallio_test` DB in the same container; existing local volumes must be reset once.                                                                                                                                                                                                     | **Approved.**                                                                                                    |
| D9  | **Boot-time privilege check** (built server refuses to start if the runtime role can do DDL, is superuser, or owns tables).                                                                                                                                                                                                                                                                                                          | **Approved.** It turns a misconfigured `NUXT_DATABASE_URL` into a startup failure.                               |
| D10 | **`pnpm test` excludes the integration project;** `pnpm test:integration` needs `pnpm db:up`. CI runs both.                                                                                                                                                                                                                                                                                                                          | **Approved.**                                                                                                    |

**Small decisions made (FYI, no approval needed):**

- PKs use `gen_random_uuid()`.
- Text and range limits as in §2.3 (Zod mirrors them).
- `normalization` and `grammatical_metadata` default to `'{}'`.
- `practice_attempts.matched_answer_id` uses ON DELETE SET NULL; `answer_change_log.answer_id` is a soft reference.
- `approval_status` is used by `answer_flags` now and by `sentence_examples` in R2.
- Exercise and source-mode enums hold MVP values only.
- Column name `learning_steps` is kept (maps to `learningStep`).
- **D12:** the layer-1 lint rule is added now (`eslint.config.mjs`, `srsBoundary`). Outside
  `server/services/srs/**`, `server/db/**`, and `tests/**` it bans importing `server/db/schema/srs`, importing
  `srsCards`/`srsReviewLogs` from the schema index (including namespace imports), member access
  `.srsCards`/`.srsReviewLogs` (e.g. `db.query.srsCards`), and string/template literals naming `srs_cards`,
  `srs_review_logs`, `srs_guard`, `set_config`, or `session_replication_role`.
- `srs_cards.updated_at` is not in the app role's column grant: the guard sets it.
- `answer_flags_check_entry_owner` (D7a) also fires on UPDATE of `user_id`/`entry_id`, since the app role can update flags.

---

## 8. Files and owners

| File                                                                                                                                                                                   | Action              | Owner                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| `shared/constants/languages.ts`, `shared/constants/enums.ts`                                                                                                                           | create              | backend                                      |
| `shared/schemas/common.ts`                                                                                                                                                             | create              | backend                                      |
| `server/db/schema/{_shared,enums,users,collections,vocabulary,srs,practice}.ts`                                                                                                        | create              | backend                                      |
| `server/db/schema/index.ts`                                                                                                                                                            | modify (re-exports) | backend                                      |
| `server/db/migrations/0001_*.sql` + `meta/*` (generated)                                                                                                                               | create              | backend                                      |
| `server/db/migrations/0002_srs_guard.sql`, `0003_integrity_triggers.sql` (D7), `0004_app_role_grants.sql`                                                                              | create (custom)     | backend                                      |
| `server/utils/env.ts`                                                                                                                                                                  | modify              | backend                                      |
| `server/utils/db-privileges.ts`, `server/db/role-gate.ts`, `server/plugins/02.db-privileges.ts`, `server/middleware/00.db-role.ts` (D9)                                                | create              | backend                                      |
| `drizzle.config.ts`, `compose.yaml`, `docker/postgres/initdb/10-roles.sh`, `.env.example`, `package.json` (scripts), `eslint.config.mjs` (D12)                                         | modify/create       | backend                                      |
| `vitest.config.ts` (integration project), `tests/integration/**`, `tests/unit/{fsrs-mapping,enums,languages}.test.ts`, `tests/unit/env.test.ts`, `tests/security/env.security.test.ts` | create/modify       | tester                                       |
| `docs/architecture.md` §4/§5/§8, README, CLAUDE.md "Commands"                                                                                                                          | modify              | docs (CLAUDE.md rule text only by Alina, D3) |
| `app/**`                                                                                                                                                                               | none                | frontend: no work                            |

The uncommitted `ts-fsrs` addition in `package.json`/`pnpm-lock.yaml` belongs on this branch
(`build(deps): pin ts-fsrs 6.0.0`).

---

## 9. Risks and invariants

1. **SRS isolation.** Layers 1, 3, and 4 now exist at the DB level: the trigger, private grants, column
   grants, no DELETE, and append-only logs. Residual risk: §3.6 (the DB can't verify FSRS math).
2. **Idempotency leak across users.** `client_review_id` is globally unique. The replay lookup **must**
   join `srs_cards` on `user_id = session user`, or another user's stored result could be returned. A
   collision across users returns 409/404, never the other user's data. This must be an IDOR test in LEX-009.
3. **Atomicity depends on order.** Log first, then card, one card per transaction, no `SET CONSTRAINTS
IMMEDIATE`. Any other order fails closed (`SR001`/`SR004`), so the only risk is availability, never integrity.
4. **Float hazards.** `NaN` passes `>= 0` checks in Postgres. All float checks use `< 'Infinity'`. The
   mapper (LEX-007) must also reject non-finite numbers before the write.
5. **ts-fsrs drift.** A version bump can add card fields or change semantics (FSRS-7 already did). U2
   fails on new fields. `scheduler_version` is stored on every card and log, and `ts-fsrs` stays pinned.
6. **Empty normalized answers** would match empty submissions. The DB check forbids them, and the
   service must reject answers that normalize to empty with a validation error.
7. **Enum evolution.** `ALTER TYPE … ADD VALUE` plus a same-batch use fails in the single-transaction
   migrator. Plan R2 enum additions as separate releases.
8. **Local migration.** Developers must recreate the Docker volume once (D8). The README and PR must say so.
9. **Ownership.** `vocabulary_entries` has no `user_id`. Ownership goes through `collections.owner_id`.
   D7(a) catches mismatched `user_id` on user-scoped child rows. Services must still scope every query (rule 5).
10. **History integrity.** Logs and attempts are append-only for the app role. Content edits never
    cascade into them. Deleting an answer only nulls `matched_answer_id`.
11. **Cascade-as-owner** is Postgres behaviour this design depends on. X1/X3 lock it in.
12. **Accessibility:** not affected (no UI).
13. **Secrets:** passwords live only in `.env`/provider secrets. The init script passes them as psql
    variables. The env validator never prints URLs. `DATABASE_MIGRATOR_URL` never reaches runtime config.

---

## 10. Consequences

- Positive: scheduling integrity, atomicity, and idempotency are enforced by Postgres, not only by code.
  The runtime credential can't change the schema. GDPR deletion is a single statement and is covered by
  an exhaustive test.
- Negative: more moving parts (2 roles, 6 trigger functions, a private grants table, custom migrations, a test DB). Every new
  table needs an explicit grant and a factory (the tests enforce this). Developers must reset their local volume once.
- Follow-ups: LEX-007 (mapper using `FSRS_CARD_FIELD_MAP`), LEX-009 (submission per §3.3 + IDOR test),
  LEX-005 (card creation; no reset, D3 = b), LEX-017 (prod role provisioning, CI Postgres service, drift check).
