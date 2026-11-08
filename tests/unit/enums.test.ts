// U1/U5 (ADR 0001 §6.1): shared enum order mirrors the ts-fsrs numeric enums.
import { Rating, State } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import { SRS_RATINGS, SRS_SCHEDULE_STATUSES, SRS_STATES } from '../../shared/constants/enums'
import { reviewRatingSchema } from '../../shared/schemas/common'

/** ts-fsrs enums are plain const objects ({ New: 0, ... }): name for a numeric value. */
const nameOf = (obj: Record<string, number>, value: number) =>
  Object.entries(obj)
    .find(([, v]) => v === value)?.[0]
    ?.toLowerCase()

describe('SRS enums', () => {
  it('SRS_STATES[i] is ts-fsrs State i', () => {
    expect(SRS_STATES.map((_, i) => nameOf(State, i))).toEqual([...SRS_STATES])
    expect(Object.keys(State)).toHaveLength(SRS_STATES.length)
  })

  it('SRS_RATINGS[i] is ts-fsrs Rating i + 1 (Again..Easy); Manual is not stored', () => {
    expect(SRS_RATINGS.map((_, i) => nameOf(Rating, i + 1))).toEqual([...SRS_RATINGS])
    expect(Rating.Manual).toBe(0)
    expect(SRS_RATINGS).not.toContain('manual')
  })

  it('schedule statuses cover new, learning and review', () => {
    expect([...SRS_SCHEDULE_STATUSES]).toEqual(['new', 'learning', 'review'])
  })

  it('the review submission schema rejects manual and unknown ratings', () => {
    for (const rating of SRS_RATINGS) expect(reviewRatingSchema.safeParse(rating).success).toBe(true)
    for (const rating of ['manual', 'Again', 'perfect', '', 3]) {
      expect(reviewRatingSchema.safeParse(rating).success).toBe(false)
    }
  })
})
