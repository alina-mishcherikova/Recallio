// Review and practice history integrity (security M1, tester M2/L1), run as the runtime app role.
// A review log belongs to the card's user, records the entry revision, and describes exactly the
// transition it authorizes. Complements srs-guard.test.ts and srs-guard.security.test.ts.
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, count, expectPgError, truncateAll } from './helpers/db'
import {
  T0,
  applyReview,
  createAttempt,
  createCard,
  createCollection,
  createEntry,
  createUser,
  getCard,
  reviewCard,
  toSnapshot,
  type CardRow,
} from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
const DAY = 86_400_000

let userId: string
let otherUser: string
let entryId: string
let card: CardRow

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  otherUser = await createUser(app)
  entryId = await createEntry(app, await createCollection(app, userId))
  card = await createCard(app, { userId, entryId })
})

describe('review log owner (tester L1)', () => {
  it("stores the card's user and rejects another user (RC001)", async () => {
    const { logId } = await reviewCard(app, card.id)
    const [log] = await app`select user_id from srs_review_logs where id = ${logId}`
    expect(log).toEqual({ user_id: userId })
    await expectPgError(reviewCard(app, card.id, {}, { userId: otherUser }), { code: 'RC001' })
  })

  it('is removed with the user', async () => {
    await reviewCard(app, card.id)
    await app`delete from users where id = ${userId}`
    expect(await count(app, 'srs_review_logs')).toBe(0)
  })
})

describe('entry revision on history rows (tester M2)', () => {
  it('a review log or attempt cannot claim a revision the entry has not reached (RC004)', async () => {
    await expectPgError(reviewCard(app, card.id, {}, { entryRevision: 2 }), { code: 'RC004' })
    await expectPgError(createAttempt(app, { userId, entryId, entryRevision: 2 }), {
      code: 'RC004',
    })
    await app`update vocabulary_entries set revision = 2 where id = ${entryId}`
    await reviewCard(app, card.id, {}, { entryRevision: 2 })
    await createAttempt(app, { userId, entryId, entryRevision: 1 }) // graded against an older revision
  })

  it('an attempt keeps its expected answer after the entry changes', async () => {
    const id = await createAttempt(app, { userId, entryId })
    await app`update vocabulary_entries set target_expression = 'le chaton', revision = 2 where id = ${entryId}`
    const [row] = await app`select expected_answer, entry_revision from practice_attempts where id = ${id}`
    expect(row).toEqual({ expected_answer: 'le chat', entry_revision: 1 })
  })
})

describe('the update must be exactly the logged transition (security M1)', () => {
  it('previous_state must be the card before the update', async () => {
    await expectPgError(
      reviewCard(app, card.id, {}, { previousState: { ...toSnapshot(card as never), reps: 7 } }),
      { code: 'SR002' },
    )
  })

  it('a snapshot with extra keys, or snake_case keys, is rejected', async () => {
    await expectPgError(
      reviewCard(app, card.id, {}, { previousState: { ...toSnapshot(card as never), extra: 1 } }),
      { code: 'SR002' },
    )
    await expectPgError(reviewCard(app, card.id, {}, { previousState: card }), { code: 'SR002' })
  })

  it('a lapse is only possible with Again', async () => {
    await reviewCard(app, card.id) // new → review
    await expectPgError(reviewCard(app, card.id, { lapses: 1, state: 'relearning' }), {
      code: 'SR002',
    })
    await reviewCard(app, card.id, { lapses: 1, state: 'relearning' }, { rating: 'again' })
    expect((await getCard(app, card.id)).lapses).toBe(1)
  })

  it('a review cannot be dated before the previous review', async () => {
    await reviewCard(app, card.id) // last_review_at = T0
    const current = await getCard(app, card.id)
    const earlier = new Date(T0.getTime() - DAY)
    await expectPgError(
      reviewCard(
        app,
        card.id,
        { last_review_at: earlier, due_at: new Date(current.due_at.getTime() + DAY) },
        { reviewedAt: earlier },
      ),
      { code: 'SR002' },
    )
  })

  it('the next due date must be after the review (due = reviewed_at passes the CHECK, not the guard)', async () => {
    await expectPgError(
      app.begin((tx) => applyReview(tx, card.id, { due_at: T0 })),
      {
        code: 'SR002',
      },
    )
    expect(await getCard(app, card.id)).toEqual(card)
  })
})

describe('card inserts (security L1)', () => {
  it('truncates due_at to milliseconds and sets updated_at', async () => {
    const other = await createEntry(app, await createCollection(app, userId))
    const [row] = await app<{ due_at: string; stored_ms: boolean }[]>`
      insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
      values (${userId}, ${other}, 'recognition', '2026-01-01T00:00:00.123456Z', 'ts-fsrs@6.0.0/fsrs-7')
      returning due_at::text, due_at = date_trunc('milliseconds', due_at) as stored_ms`
    expect(row!.stored_ms).toBe(true)
    expect(row!.due_at).toContain('00:00:00.123')
  })

  it('accepts a due_at within the next five minutes (clock skew)', async () => {
    const other = await createEntry(app, await createCollection(app, userId))
    await createCard(app, { userId, entryId: other, dueAt: new Date(Date.now() + 60_000) })
  })
})
