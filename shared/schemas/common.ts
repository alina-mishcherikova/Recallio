import { z } from '../zod'
import {
  ANSWER_CHANGE_ACTIONS,
  APPROVAL_STATUSES,
  DIRECTIONS,
  EXERCISE_TYPES,
  PRACTICE_SOURCE_MODES,
  SRS_RATINGS,
} from '../constants/enums'

export { languageCodeSchema } from '../constants/languages'

export const directionSchema = z.enum(DIRECTIONS)
/** Ratings accepted by `POST /api/review/submit`. */
export const reviewRatingSchema = z.enum(SRS_RATINGS)
export const exerciseTypeSchema = z.enum(EXERCISE_TYPES)
export const practiceSourceModeSchema = z.enum(PRACTICE_SOURCE_MODES)
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES)
export const answerChangeActionSchema = z.enum(ANSWER_CHANGE_ACTIONS)
