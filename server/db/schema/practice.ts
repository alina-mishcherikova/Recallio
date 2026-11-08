import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tsz } from './_shared'
import { directionEnum, exerciseTypeEnum, practiceSourceModeEnum } from './enums'
import { users } from './users'
import { acceptedAnswers, vocabularyEntries } from './vocabulary'

// Append-only for the app role, and no relation to srs_*: practice never changes FSRS (CLAUDE.md rule 1).
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
    // Snapshot of what was expected, so history stays readable after the entry is edited.
    expectedAnswer: text('expected_answer').notNull(),
    entryRevision: integer('entry_revision').notNull(), // entry revision the attempt was graded against
    matchedAnswerId: uuid('matched_answer_id').references(() => acceptedAnswers.id, {
      onDelete: 'set null',
    }),
    isCorrect: boolean('is_correct').notNull(),
    diff: jsonb('diff').$type<unknown[]>(),
    sessionId: uuid('session_id').notNull(), // client practice-session id; no table in the MVP
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('practice_attempts_user_created_idx').on(t.userId, t.createdAt),
    index('practice_attempts_entry_idx').on(t.entryId),
    index('practice_attempts_matched_answer_idx').on(t.matchedAnswerId),
    check('practice_attempts_submitted_len', sql`char_length(${t.submittedAnswer}) <= 500`),
    check('practice_attempts_expected_len', sql`char_length(${t.expectedAnswer}) between 1 and 500`),
    check('practice_attempts_entry_revision_positive', sql`${t.entryRevision} >= 1`),
    // A match implies correct. The reverse can't be required because SET NULL clears the id.
    check('practice_attempts_match_implies_correct', sql`${t.matchedAnswerId} is null or ${t.isCorrect}`),
    check('practice_attempts_diff_array', sql`${t.diff} is null or jsonb_typeof(${t.diff}) = 'array'`),
  ],
)
