// U2 (ADR 0001 §6.1): storage must be lossless. Fails when a ts-fsrs upgrade adds a card field
// that srs_cards does not store (ts-fsrs stays pinned; scheduler_version is stored on every row).
import { getTableColumns } from 'drizzle-orm'
import { DefaultScheduler, Rating } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import { FSRS_CARD_FIELD_MAP, srsCards } from '../../server/db/schema/srs'

const now = new Date('2026-01-01T00:00:00.000Z')
const later = (days: number) => new Date(now.getTime() + days * 86_400_000)

async function producedCardKeys(version?: 'FSRS-6'): Promise<Set<string>> {
  const scheduler = await DefaultScheduler(version ? { version } : undefined)
  const keys = new Set<string>()
  let card = scheduler.newCard({ cardId: 'card-1', now })
  Object.keys(card).forEach((k) => keys.add(k))
  // Walk through new → learning/review → relearning so every state's fields are seen.
  for (const [grade, at] of [
    [Rating.Good, now],
    [Rating.Good, later(5)],
    [Rating.Again, later(30)],
    [Rating.Easy, later(31)],
  ] as const) {
    const { card: next, revlog } = scheduler.review({ card, grade, now: at })
    Object.keys(next).forEach((k) => keys.add(k))
    // The revlog is the pre-review card plus rating/reviewTime: stored as previous_state, rating, reviewed_at.
    Object.keys(revlog)
      .filter((k) => k !== 'rating' && k !== 'reviewTime')
      .forEach((k) => keys.add(k))
    card = next
  }
  // forget() returns the reset card itself (no revlog) and must not introduce fields either.
  Object.keys(scheduler.forget({ card, now: later(40) })).forEach((k) => keys.add(k))
  return keys
}

describe('ts-fsrs card ↔ srs_cards mapping', () => {
  const columns = new Set(Object.keys(getTableColumns(srsCards)))

  it.each([
    ['FSRS-7 (default)', undefined],
    ['FSRS-6', 'FSRS-6' as const],
  ])('every %s card field is mapped to a stored column', async (_label, version) => {
    const produced = await producedCardKeys(version)
    const unmapped = [...produced].filter((k) => !(k in FSRS_CARD_FIELD_MAP))
    expect(unmapped, 'ts-fsrs produces card fields that srs_cards does not store').toEqual([])
  })

  it('every mapped field is a real srs_cards column', () => {
    for (const [field, column] of Object.entries(FSRS_CARD_FIELD_MAP)) {
      expect(columns.has(column), `${field} → ${column}`).toBe(true)
    }
  })

  it('maps exactly the FSRS-7 card shape (no stale fields)', async () => {
    const produced = await producedCardKeys()
    expect(Object.keys(FSRS_CARD_FIELD_MAP).sort()).toEqual([...produced].sort())
  })
})
