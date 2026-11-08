// Abuse cases for the SRS guard (ADR 0001 §3, CLAUDE.md rule 1), run as the runtime app role.
// Complements srs-guard.test.ts. Each "Gap"/"finding" case was a known gap from the LEX-002 security
// review (`it.fails` until fixed).
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, count, expectPgError, pgError, truncateAll, waitForLockWait } from './helpers/db'
import {
  T0,
  applyReview,
  createCard,
  createCollection,
  createEntry,
  createUser,
  getCard,
  insertLog,
  nextCardState,
  type CardRow,
} from './helpers/factories'

const app = connectAs('app')
const app2 = connectAs('app') // independent pool for concurrent transactions
const migrator = connectAs('migrator')

let userId: string
let entryId: string
let card: CardRow

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  entryId = await createEntry(app, await createCollection(app, userId))
  card = await createCard(app, { userId, entryId, direction: 'recognition' })
})

describe('the app role cannot escalate or switch off triggers', () => {
  it('cannot SET ROLE to the migrator (table and function owner)', async () => {
    await expectPgError(app`set role recallio_migrator`, { code: '42501' })
  })

  it('holds no SET privilege on session_replication_role (replica mode would skip every trigger)', async () => {
    const [row] = await app<{ ok: boolean }[]>`
      select pg_catalog.has_parameter_privilege('session_replication_role', 'SET') as ok`
    expect(row!.ok).toBe(false)
  })

  it('cannot shadow catalog functions through search_path (no TEMP, no CREATE on public)', async () => {
    await expectPgError(app`create temp table review_grants (x int)`, { code: '42501' })
    await expectPgError(
      app`create function public.pg_current_xact_id() returns xid8 language sql as 'select 1::xid8'`,
      { code: '42501' },
    )
  })
})

describe('history is append-only and cards cannot be removed by the app role', () => {
  it('cannot UPDATE or DELETE review logs, or DELETE cards, or write updated_at', async () => {
    await app.begin((tx) => applyReview(tx, card.id))
    await expectPgError(app`update srs_review_logs set rating = 'easy'`, { code: '42501' })
    await expectPgError(app`delete from srs_review_logs`, { code: '42501' })
    await expectPgError(app`delete from srs_cards where id = ${card.id}`, { code: '42501' })
    await expectPgError(app`update srs_cards set updated_at = now() where id = ${card.id}`, {
      code: '42501',
    })
    expect(await count(app, 'srs_review_logs')).toBe(1)
  })
})

describe('concurrent reviews of one card', () => {
  it('a second transaction built on a stale card is rejected (lost update → SR002)', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let firstApplied!: () => void
    const applied = new Promise<void>((resolve) => (firstApplied = resolve))

    // T1 reviews and keeps the row lock. T2 read the card before T1 committed, so its log carries
    // the old due_at. Without FOR UPDATE in T2, the guard is the last line of defense.
    const stale = await getCard(app, card.id)
    const first = app.begin(async (tx) => {
      await applyReview(tx, card.id)
      firstApplied()
      await held
    })
    await applied
    const second = app2.begin(async (tx) => {
      const next = nextCardState(stale, { due_at: new Date(T0.getTime() + 9 * 86_400_000) })
      await insertLog(tx, {
        cardId: card.id,
        previousDueAt: stale.due_at,
        nextDueAt: next.due_at as Date,
      })
      await tx`update srs_cards set ${tx(next)} where id = ${card.id}` // blocks on T1's row lock
    })
    try {
      await waitForLockWait(app) // T2 blocks on T1's row lock (its log insert takes FOR KEY SHARE)
    } finally {
      release()
    }
    await first
    const error = await pgError(second)
    expect(error.code).toBe('SR002')
    expect(await count(app, 'srs_review_logs')).toBe(1)
  })
})

// Gap 3 (review finding M2): the guard checks only card_id, previous/next due_at and scheduler_version.
// Every other scheduling column, and the log's next_state snapshot, can disagree with the update.
describe('a review log must describe the update it authorizes', () => {
  it('next_state that does not match the new card values → SR002', async () => {
    await expectPgError(
      app.begin((tx) => applyReview(tx, card.id, {}, { nextState: { forged: true } })),
      { code: 'SR002' },
    )
  })

  it('reps jumping by more than one review → SR002', async () => {
    await expectPgError(
      app.begin((tx) => applyReview(tx, card.id, { reps: 999, stability: 99_999 })),
      { code: 'SR002' },
    )
  })

  it('last_review_at different from the log reviewed_at → SR002', async () => {
    await expectPgError(
      app.begin((tx) => applyReview(tx, card.id, { last_review_at: new Date('1999-01-01T00:00:00Z') })),
      { code: 'SR002' },
    )
  })

  it('scheduling change that keeps due_at (log previous = next due) → SR002', async () => {
    await expectPgError(
      app.begin((tx) => applyReview(tx, card.id, { due_at: card.due_at, state: 'review', reps: 1 })),
      { code: 'SR002' },
    )
  })
})

// Review finding L1: "pristine new card" (SR006) does not cover due_at, scheduler_version or updated_at.
describe('a new card cannot be inserted pre-scheduled', () => {
  it('a far-future due_at (silently suspended card) → SR006', async () => {
    const other = await createEntry(app, await createCollection(app, userId))
    await expectPgError(
      createCard(app, { userId, entryId: other, dueAt: new Date('9999-12-31T00:00:00Z') }),
      { code: 'SR006' },
    )
  })

  it('a client-supplied updated_at is not stored', async () => {
    const other = await createEntry(app, await createCollection(app, userId))
    const [row] = await app<{ updated_at: Date }[]>`
      insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version, updated_at)
      values (${userId}, ${other}, 'production', ${T0}, 'ts-fsrs@6.0.0/fsrs-7', '2000-01-01T00:00:00Z')
      returning updated_at`
    expect(row!.updated_at.getTime()).toBeGreaterThan(Date.parse('2001-01-01T00:00:00Z'))
  })
})
