// Relative imports: drizzle-kit loads this file outside Nuxt and cannot resolve `#shared`.
import { pgEnum } from 'drizzle-orm/pg-core'
import {
  ANSWER_CHANGE_ACTIONS,
  APPROVAL_STATUSES,
  DIRECTIONS,
  EXERCISE_TYPES,
  PRACTICE_SOURCE_MODES,
  SRS_RATINGS,
  SRS_SCHEDULE_STATUSES,
  SRS_STATES,
} from '../../../shared/constants/enums'

export const directionEnum = pgEnum('direction', DIRECTIONS)
export const srsStateEnum = pgEnum('srs_state', SRS_STATES)
export const srsScheduleStatusEnum = pgEnum('srs_schedule_status', SRS_SCHEDULE_STATUSES)
export const srsRatingEnum = pgEnum('srs_rating', SRS_RATINGS)
export const exerciseTypeEnum = pgEnum('exercise_type', EXERCISE_TYPES)
export const practiceSourceModeEnum = pgEnum('practice_source_mode', PRACTICE_SOURCE_MODES)
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES)
export const answerChangeActionEnum = pgEnum('answer_change_action', ANSWER_CHANGE_ACTIONS)
