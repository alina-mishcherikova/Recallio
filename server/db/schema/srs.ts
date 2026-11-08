// SRS tables. Writable ONLY from server/services/srs/** (lint rule in eslint.config.mjs) and
// guarded in the database (migration 0002: grants, pristine-insert, deferred log check).
import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
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
import { directionEnum, srsRatingEnum, srsScheduleStatusEnum, srsStateEnum } from './enums'
import { users } from './users'
import { vocabularyEntries } from './vocabulary'

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
    scheduleStatus: srsScheduleStatusEnum('schedule_status').notNull().default('new'),
    dueAt: tsz('due_at').notNull(),
    stability: doublePrecision('stability').notNull().default(0),
    stabilityFast: doublePrecision('stability_fast'), // FSRS-7 only (null for FSRS-6 cards)
    difficulty: doublePrecision('difficulty').notNull().default(0),
    scheduledDays: doublePrecision('scheduled_days').notNull().default(0), // fractional in FSRS-7
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
    // `x < 'Infinity'` also rejects NaN (NaN sorts above Infinity in Postgres; `NaN >= 0` is TRUE).
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

/** Append-only for the app role. Each row authorizes exactly one card update (migration 0002). */
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

/**
 * ts-fsrs `DefaultScheduler` card key → `srsCards` property. Storage must be lossless:
 * tests/unit/fsrs-mapping.test.ts fails if ts-fsrs produces a key that is not mapped here.
 */
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
} as const satisfies Record<string, keyof typeof srsCards.$inferSelect>
