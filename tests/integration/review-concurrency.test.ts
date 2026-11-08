// Concurrent review submissions on the SAME card (ADR 0001 §3.3, CLAUDE.md rule 2).
// schema.constraints.test.ts covers a duplicate client_review_id on two different cards; these cover
// the row lock: a replay of the same submission, and two distinct submissions racing on one card.
// The stale-read (no FOR UPDATE) case is in srs-guard.security.test.ts.
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, count, expectPgError, truncateAll, waitForLockWait } from './helpers/db'
import {
  applyReview,
  createCard,
  createCollection,
  createEntry,
  createUser,
  getCard,
  type CardRow,
} from './helpers/factories'

const app = connectAs('app')
const other = connectAs('app') // a second pool, so the two transactions use different connections
const migrator = connectAs('migrator')

let card: CardRow

beforeEach(async () => {
  await truncateAll(migrator)
  const userId = await createUser(app)
  card = await createCard(app, {
    userId,
    entryId: await createEntry(app, await createCollection(app, userId)),
  })
})

/** Starts tx A, lets it take the row lock and write, and holds it open until `release()`. */
function holdFirst(fn: Parameters<typeof applyReview>[2] = {}, log: Parameters<typeof applyReview>[3] = {}) {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let ready!: () => void
  const applied = new Promise<void>((r) => (ready = r))
  const done = app.begin(async (tx) => {
    const result = await applyReview(tx, card.id, fn, log)
    ready()
    await held
    return result
  })
  return { applied, done, release }
}

describe('same card, concurrent submissions', () => {
  it('a concurrent replay of the same client_review_id waits on the row lock, then fails with 23505', async () => {
    const clientReviewId = randomUUID()
    const first = holdFirst({}, { clientReviewId })
    await first.applied
    const second = other.begin((tx) => applyReview(tx, card.id, {}, { clientReviewId }))
    try {
      await waitForLockWait(app)
    } finally {
      first.release() // never leave the first transaction open, or the next TRUNCATE hangs
    }

    const { next } = await first.done
    await expectPgError(second, { code: '23505', constraint: 'srs_review_logs_card_client_review_id_key' })
    expect(await count(app, 'srs_review_logs')).toBe(1)
    expect(await getCard(app, card.id)).toMatchObject({ reps: 1, due_at: next.due_at })
  })

  it('two distinct submissions serialize: the second is computed from the first one’s result', async () => {
    const first = holdFirst()
    await first.applied
    const second = other.begin((tx) => applyReview(tx, card.id, { reps: 2 }))
    try {
      await waitForLockWait(app)
    } finally {
      first.release() // never leave the first transaction open, or the next TRUNCATE hangs
    }

    const a = await first.done
    const b = await second
    const logs = await app<{ id: string; previous_due_at: Date; next_due_at: Date }[]>`
      select id, previous_due_at, next_due_at from srs_review_logs order by reviewed_at`
    expect(logs).toHaveLength(2)
    expect(logs[1]!.previous_due_at).toEqual(a.next.due_at) // chained, not both from the stale card
    expect((await getCard(app, card.id)).due_at).toEqual(b.next.due_at)
  })
})
