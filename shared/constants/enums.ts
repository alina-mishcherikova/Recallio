// Single source for Postgres enums (server/db/schema/enums.ts) and Zod (shared/schemas/common.ts).
// Never reorder: the SRS tuples mirror ts-fsrs numeric enums (tests/unit/enums.test.ts).

/** Language direction is always explicit (CLAUDE.md): recognition = target→native, production = native→target. */
export const DIRECTIONS = ['recognition', 'production'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** ts-fsrs `State` 0..3 (New, Learning, Review, Relearning). */
export const SRS_STATES = ['new', 'learning', 'review', 'relearning'] as const
export type SrsState = (typeof SRS_STATES)[number]

/** ts-fsrs 6 `scheduleStatus`. Not derivable from `state` (Relearning maps to 'learning'). */
export const SRS_SCHEDULE_STATUSES = ['new', 'learning', 'review'] as const
export type SrsScheduleStatus = (typeof SRS_SCHEDULE_STATUSES)[number]

/**
 * ts-fsrs `Rating` 1..4 (Again, Hard, Good, Easy). `Rating.Manual` (0) is deliberately absent:
 * there is no reset path in the MVP (ADR 0001 D2/D3).
 */
export const SRS_RATINGS = ['again', 'hard', 'good', 'easy'] as const
export type SrsRating = (typeof SRS_RATINGS)[number]

/** MVP values only; R2/R3 values are added by migration. */
export const EXERCISE_TYPES = ['typing', 'multiple_choice'] as const
export type ExerciseType = (typeof EXERCISE_TYPES)[number]

export const PRACTICE_SOURCE_MODES = ['typing', 'multiple_choice', 'difficult_words'] as const
export type PracticeSourceMode = (typeof PRACTICE_SOURCE_MODES)[number]

/** Used by answer_flags now and by sentence_examples in R2. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const ANSWER_CHANGE_ACTIONS = ['create', 'update', 'delete'] as const
export type AnswerChangeAction = (typeof ANSWER_CHANGE_ACTIONS)[number]
