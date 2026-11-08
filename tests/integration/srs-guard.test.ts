// SRS database guard (ADR 0001 §3, D4 = variant B), exercised as the runtime app role.
// The only way to change a card's schedule is the review-submission shape: one transaction,
// log first (opens a grant), then the matching card update (consumes it).
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, count, expectPgError, pgError, truncateAll } from './helpers/db'
import {
  SCHEDULING_COLUMNS,
  T0,
  applyReview,
  createCard,
  createCollection,
  createEntry,
  createUser,
  getCard,
  insertLog,
  nextCardState,
  reviewCard,
  type CardRow,
} from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

let userId: string
let entryId: string
let card: CardRow
let other: CardRow

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  entryId = await createEntry(app, await createCollection(app, userId))
  card = await createCard(app, { userId, entryId, direction: 'recognition' })
  other = await createCard(app, { userId, entryId, direction: 'production' })
})

const changed: Record<(typeof SCHEDULING_COLUMNS)[number], unknown> = {
  state: 'learning',
  schedule_status: 'learning',
  due_at: new Date(T0.getTime() + 60_000),
  stability: 1,
  stability_fast: 1,
  difficulty: 1,
  scheduled_days: 1,
  learning_steps: 1,
  reps: 1,
  lapses: 1,
  last_review_at: T0,
  scheduler_version: 'ts-fsrs@6.0.0/fsrs-6',
}

describe('updates without a review log are blocked', () => {
  it.each(SCHEDULING_COLUMNS)('UPDATE of %s without a log fails with SR001', async (column) => {
    await expectPgError(
      app`update srs_cards set ${app(column)} = ${changed[column] as string} where id = ${card.id}`,
      { code: 'SR001' },
    )
    expect(await getCard(app, card.id)).toEqual(card)
  })

  it('a no-op update needs no grant', async () => {
    await app`update srs_cards set reps = reps, due_at = due_at where id = ${card.id}`
    expect(await getCard(app, card.id)).toEqual(card)
  })

  it('setting the old app.review_id setting has no effect', async () => {
    await expectPgError(
      app.begin(async (tx) => {
        await tx`select pg_catalog.set_config('app.review_id', ${randomUUID()}, true)`
        await tx`update srs_cards set reps = 1 where id = ${card.id}`
      }),
      { code: 'SR001' },
    )
  })

  it('a log committed earlier cannot authorize a later update (no replay)', async () => {
    const { next } = await reviewCard(app, card.id)
    await expectPgError(
      app`update srs_cards set due_at = ${next.due_at as Date}, reps = 2 where id = ${card.id}`,
      { code: 'SR001' },
    )
  })
})

describe('the review path (grant opened by the SECURITY DEFINER trigger) works', () => {
  it('log + matching update commit; the card has the new values and updated_at advances', async () => {
    const { logId, next } = await reviewCard(app, card.id)
    const after = await getCard(app, card.id)
    expect(after).toMatchObject(next)
    expect(after.updated_at.getTime()).toBeGreaterThan(card.updated_at.getTime())
    expect(await count(app, 'srs_review_logs')).toBe(1)
    const [log] = await app`select card_id, scheduler_version from srs_review_logs where id = ${logId}`
    expect(log).toEqual({ card_id: card.id, scheduler_version: card.scheduler_version })
    expect(await count(migrator, 'srs_guard.review_grants')).toBe(0)
  })

  it('consecutive reviews of the same card each need their own log', async () => {
    await reviewCard(app, card.id)
    await reviewCard(app, card.id, { reps: 2 })
    expect((await getCard(app, card.id)).reps).toBe(2)
    expect(await count(app, 'srs_review_logs')).toBe(2)
  })

  it('a review inside a released savepoint commits', async () => {
    await app.begin((tx) => tx.savepoint((sp) => applyReview(sp, card.id)))
    expect((await getCard(app, card.id)).reps).toBe(1)
  })

  it('a log-only insert in a rolled-back savepoint leaves nothing behind', async () => {
    await app.begin(async (tx) => {
      await tx
        .savepoint(async (sp) => {
          await insertLog(sp, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at })
          throw new Error('rollback savepoint')
        })
        .catch(() => {})
    })
    expect(await count(app, 'srs_review_logs')).toBe(0)
    expect(await getCard(app, card.id)).toEqual(card)
  })
})

describe('a log without its card update fails at commit', () => {
  it('log insert without an update in a transaction fails with SR004 and is not stored', async () => {
    await expectPgError(
      app.begin((tx) =>
        insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at }),
      ),
      { code: 'SR004' },
    )
    expect(await count(app, 'srs_review_logs')).toBe(0)
  })

  it('an autocommit log insert fails with SR004', async () => {
    await expectPgError(
      insertLog(app, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at }),
      { code: 'SR004' },
    )
    expect(await count(app, 'srs_review_logs')).toBe(0)
  })

  it('SET CONSTRAINTS ALL IMMEDIATE fails closed instead of skipping the check', async () => {
    await expectPgError(
      app.begin(async (tx) => {
        await tx`set constraints all immediate`
        await insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at })
      }),
      { code: 'SR004' },
    )
  })
})

describe('the update must match the pending log', () => {
  it('a log for card A does not authorize an update of card B (SR002)', async () => {
    await expectPgError(
      app.begin(async (tx) => {
        const next = nextCardState(other)
        await insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: next.due_at as Date })
        await tx`update srs_cards set ${tx(next)} where id = ${other.id}`
      }),
      { code: 'SR002' },
    )
    expect(await getCard(app, other.id)).toEqual(other)
  })

  it.each([
    ['next due_at differs from the log', { nextDueAt: new Date(T0.getTime() + 1) }],
    ['scheduler_version differs from the log', { schedulerVersion: 'ts-fsrs@6.0.0/fsrs-6' }],
    ['previous_due_at differs from the card', { previousDueAt: new Date(T0.getTime() - 1) }],
  ])('%s → SR002', async (_label, log) => {
    await expectPgError(reviewCard(app, card.id, {}, log), { code: 'SR002' })
    expect(await getCard(app, card.id)).toEqual(card)
  })

  it('one log authorizes exactly one update (second update → SR001)', async () => {
    await expectPgError(
      app.begin(async (tx) => {
        const { next } = await applyReview(tx, card.id)
        await tx`update srs_cards set reps = ${(next.reps as number) + 1} where id = ${card.id}`
      }),
      { code: 'SR001' },
    )
    expect(await getCard(app, card.id)).toEqual(card)
  })

  it('a multi-row update is authorized for one row at most', async () => {
    const error = await pgError(
      app.begin(async (tx) => {
        const next = nextCardState(card)
        await insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: next.due_at as Date })
        await tx`update srs_cards set ${tx(next)} where user_id = ${userId}`
      }),
    )
    // Row order is not guaranteed: the non-matching row fails with SR002 if it comes first,
    // otherwise the matching row consumes the grant and the next one fails with SR001.
    expect(['SR001', 'SR002']).toContain(error.code)
    expect(await getCard(app, card.id)).toEqual(card)
    expect(await getCard(app, other.id)).toEqual(other)
  })

  it('a second log before the first is applied fails with SR003', async () => {
    await expectPgError(
      app.begin(async (tx) => {
        await insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at })
        await insertLog(tx, { cardId: other.id, previousDueAt: other.due_at, nextDueAt: other.due_at })
      }),
      { code: 'SR003' },
    )
  })
})

describe('the app role cannot forge, read, or clear a grant', () => {
  it('cannot insert into, read, or delete from srs_guard.review_grants', async () => {
    const logId = randomUUID()
    await expectPgError(
      app`insert into srs_guard.review_grants (log_id, card_id, xact_id)
          values (${logId}, ${card.id}, pg_catalog.pg_current_xact_id())`,
      { code: '42501' },
    )
    await expectPgError(app`select * from srs_guard.review_grants`, { code: '42501' })
    await expectPgError(
      app.begin(async (tx) => {
        await insertLog(tx, { cardId: card.id, previousDueAt: card.due_at, nextDueAt: card.due_at })
        await tx`delete from srs_guard.review_grants` // would let the log commit alone
      }),
      { code: '42501' },
    )
    expect(await count(app, 'srs_review_logs')).toBe(0)
  })

  it.each([
    'srs_review_logs_open_grant',
    'srs_cards_guard_update',
    'srs_review_logs_require_applied',
    'srs_cards_guard_insert',
  ])('cannot call %s() directly', async (fn) => {
    await expectPgError(app`select ${app(fn)}()`, { code: '42501' })
  })

  it('cannot disable the guard', async () => {
    await expectPgError(app`set session_replication_role = replica`, { code: '42501' })
    await expectPgError(app`alter table srs_cards disable trigger srs_cards_guard_update`, {
      code: '42501',
    })
    await expectPgError(app`alter table srs_review_logs disable trigger all`, { code: '42501' })
  })
})

describe('identity columns are immutable', () => {
  it.each(['user_id', 'entry_id', 'direction'])(
    'app UPDATE of %s → 42501 (no column privilege)',
    async (column) => {
      const value = column === 'direction' ? 'production' : randomUUID()
      await expectPgError(app`update srs_cards set ${app(column)} = ${value} where id = ${card.id}`, {
        code: '42501',
      })
    },
  )

  it('even the owner cannot change identity (SR005)', async () => {
    const third = await createEntry(app, await createCollection(app, userId))
    await expectPgError(migrator`update srs_cards set entry_id = ${third} where id = ${card.id}`, {
      code: 'SR005',
    })
  })
})

describe('new cards can only be inserted unscheduled', () => {
  it('a pristine card insert works', async () => {
    const entry = await createEntry(app, await createCollection(app, userId))
    const created = await createCard(app, { userId, entryId: entry })
    expect(created).toMatchObject({ state: 'new', schedule_status: 'new', reps: 0, last_review_at: null })
  })

  it.each([
    ['reps = 1', { reps: 1 }],
    ['lapses = 1', { lapses: 1 }],
    ["state = 'review'", { state: 'review' }],
    ["schedule_status = 'learning'", { schedule_status: 'learning' }],
    ['last_review_at set', { last_review_at: T0 }],
    ['stability = 1', { stability: 1 }],
    ['stability_fast = 1', { stability_fast: 1 }],
    ['difficulty = 5', { difficulty: 5 }],
    ['scheduled_days = 3', { scheduled_days: 3 }],
    ['learning_steps = 1', { learning_steps: 1 }],
  ])('insert with %s → SR006', async (_label, patch) => {
    const entry = await createEntry(app, await createCollection(app, userId))
    const row = {
      user_id: userId,
      entry_id: entry,
      direction: 'recognition',
      due_at: T0,
      scheduler_version: card.scheduler_version,
      ...patch,
    }
    await expectPgError(app`insert into srs_cards ${app(row)}`, { code: 'SR006' })
  })

  it('ON CONFLICT DO NOTHING is idempotent and leaves the card unchanged', async () => {
    await reviewCard(app, card.id)
    const reviewed = await getCard(app, card.id)
    const result = await app`
      insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
      values (${userId}, ${entryId}, 'recognition', ${T0}, ${card.scheduler_version})
      on conflict (user_id, entry_id, direction) do nothing`
    expect(result.count).toBe(0)
    expect(await getCard(app, card.id)).toEqual(reviewed)
  })

  it('ON CONFLICT DO UPDATE of scheduling fields → SR001 (import cannot overwrite history)', async () => {
    await expectPgError(
      app`
        insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
        values (${userId}, ${entryId}, 'recognition', ${T0}, ${card.scheduler_version})
        on conflict (user_id, entry_id, direction) do update set due_at = excluded.due_at + interval '1 day'`,
      { code: 'SR001' },
    )
  })
})
