// ts-fsrs 6.0.0 ↔ srs_cards / srs_review_logs round trip through the real database (ADR 0001 §1.2, D1).
// A card produced by `DefaultScheduler()` is stored, reviewed with each rating through the guarded
// review path (log first, then card), read back with Drizzle and mapped back into a ts-fsrs card.
// Storage must be lossless: due as a timestamp (ms), fractional scheduled_days, both state enums,
// stability_fast (FSRS-7) and null stability_fast (FSRS-6), and the jsonb snapshots in the log.
// Snapshots use the documented format (SRS_SNAPSHOT_KEYS: the 12 scheduling columns as Drizzle
// properties), which the guard compares with the card before and after the update.
// The mapper here is test-local; LEX-007 owns the production mapper and must satisfy the same test.
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { DefaultScheduler, Rating } from 'ts-fsrs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FSRS_CARD_FIELD_MAP,
  SRS_SNAPSHOT_KEYS,
  srsCards,
  srsReviewLogs,
  type SrsCardSnapshot,
} from '../../server/db/schema/srs'
import { SRS_RATINGS, SRS_STATES } from '../../shared/constants/enums'
import { connectAs, truncateAll } from './helpers/db'
import { createCollection, createEntry, createUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
const db = drizzle(app)

type Scheduler = Awaited<ReturnType<typeof DefaultScheduler>>
type FsrsCard = ReturnType<Scheduler['newCard']>
type CardRow = typeof srsCards.$inferSelect
/** The scheduler type is FSRS-7's; FSRS-6 cards (no stabilityFast) are passed through as-is. */
const asInput = (card: FsrsCard) => card as never
type Grade = typeof Rating.Again | typeof Rating.Hard | typeof Rating.Good | typeof Rating.Easy

const VERSIONS = [
  { label: 'FSRS-7 (default)', options: undefined, schedulerVersion: 'ts-fsrs@6.0.0/fsrs-7' },
  { label: 'FSRS-6', options: { version: 'FSRS-6' as const }, schedulerVersion: 'ts-fsrs@6.0.0/fsrs-6' },
]
const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const
const NOW = new Date('2026-01-01T08:30:15.123Z') // non-zero ms on purpose
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000)

/** Scheduling columns as Drizzle properties (everything in the map except the id). */
function toColumns(card: FsrsCard, schedulerVersion: string) {
  const c = card as unknown as Record<string, unknown>
  return {
    state: SRS_STATES[card.state as number]!,
    scheduleStatus: card.scheduleStatus as CardRow['scheduleStatus'],
    dueAt: card.dueAt,
    stability: card.stability,
    stabilityFast: (c.stabilityFast as number | undefined) ?? null,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningStep,
    reps: card.reps,
    lapses: card.lapses,
    lastReviewAt: card.lastReviewAt,
    schedulerVersion,
  } satisfies Partial<CardRow>
}

/** DB row → ts-fsrs card, driven by FSRS_CARD_FIELD_MAP so the map itself is exercised. */
function fromRow(row: CardRow): FsrsCard {
  const card: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(FSRS_CARD_FIELD_MAP)) {
    const value = row[column]
    if (field === 'state') card[field] = SRS_STATES.indexOf(value as CardRow['state'])
    else if (field === 'stabilityFast' && value === null)
      continue // FSRS-6 cards have no such field
    else card[field] = value
  }
  return card as unknown as FsrsCard
}

/** jsonb snapshot (SRS_SNAPSHOT_KEYS) → ts-fsrs card. JSON turns Dates into ISO strings. */
function fromSnapshot(snap: Record<string, unknown>, id: string): FsrsCard {
  expect(Object.keys(snap).sort()).toEqual([...SRS_SNAPSHOT_KEYS].sort())
  return fromRow({
    ...snap,
    id,
    dueAt: new Date(snap.dueAt as string),
    lastReviewAt: snap.lastReviewAt === null ? null : new Date(snap.lastReviewAt as string),
  } as unknown as CardRow)
}

const snapshot = (card: FsrsCard, schedulerVersion: string) =>
  JSON.parse(JSON.stringify(toColumns(card, schedulerVersion))) as SrsCardSnapshot

async function insertNewCard(
  scheduler: Scheduler,
  schedulerVersion: string,
  userId: string,
  entryId: string,
) {
  const id = randomUUID()
  const card = scheduler.newCard({ cardId: id, now: NOW })
  const [row] = await db
    .insert(srsCards)
    .values({ id, userId, entryId, direction: 'recognition', ...toColumns(card, schedulerVersion) })
    .returning()
  return { card, row: row! }
}

/** The LEX-009 shape (ADR 0001 §3.3), written with Drizzle: lock, log, card update, one transaction. */
async function review(
  cardId: string,
  grade: Grade,
  now: Date,
  scheduler: Scheduler,
  schedulerVersion: string,
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(srsCards).where(eq(srsCards.id, cardId)).for('update')
    const previous = fromRow(locked!)
    const { card: next } = scheduler.review({ card: asInput(previous), grade, now })
    await tx.insert(srsReviewLogs).values({
      cardId,
      userId: locked!.userId,
      entryRevision: 1,
      clientReviewId: randomUUID(),
      rating: SRS_RATINGS[grade - 1]!,
      reviewedAt: now,
      previousState: snapshot(previous, schedulerVersion),
      nextState: snapshot(next, schedulerVersion),
      previousDueAt: previous.dueAt,
      nextDueAt: next.dueAt,
      schedulerVersion,
    })
    await tx.update(srsCards).set(toColumns(next, schedulerVersion)).where(eq(srsCards.id, cardId))
    return next
  })
}

const readCard = async (id: string) => (await db.select().from(srsCards).where(eq(srsCards.id, id)))[0]!

let userId: string
let entryId: string

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  entryId = await createEntry(app, await createCollection(app, userId))
})

describe.each(VERSIONS)('$label card ↔ row round trip', ({ options, schedulerVersion }) => {
  let scheduler: Scheduler
  beforeEach(async () => {
    scheduler = await DefaultScheduler(options)
  })

  it('a new card is stored pristine and reads back identical', async () => {
    const { card, row } = await insertNewCard(scheduler, schedulerVersion, userId, entryId)
    expect(fromRow(row)).toStrictEqual(card)
    expect(fromRow(await readCard(row.id))).toStrictEqual(card)
    expect(row.stabilityFast).toBe(options ? null : 0)
  })

  it.each(GRADES.map((g) => [SRS_RATINGS[g - 1], g] as const))(
    'review with %s: card, log row and jsonb snapshots are lossless',
    async (rating, grade) => {
      const { card: fresh, row } = await insertNewCard(scheduler, schedulerVersion, userId, entryId)
      const expected = scheduler.review({ card: asInput(fresh), grade, now: NOW }).card

      const next = await review(row.id, grade, NOW, scheduler, schedulerVersion)
      expect(next).toStrictEqual(expected)

      const stored = await readCard(row.id)
      const restored = fromRow(stored)
      expect(restored).toStrictEqual(expected)
      // Spot checks for the hazards named in ADR 0001 §1.2.
      expect(stored.dueAt).toBeInstanceOf(Date)
      expect(stored.dueAt.getTime()).toBe(expected.dueAt.getTime())
      expect(Object.is(stored.scheduledDays, expected.scheduledDays)).toBe(true)
      expect(stored.state).toBe(SRS_STATES[expected.state as number])
      expect(stored.scheduleStatus).toBe(expected.scheduleStatus)

      const [log] = await db.select().from(srsReviewLogs).where(eq(srsReviewLogs.cardId, row.id))
      expect(log!.rating).toBe(rating)
      expect(log!.previousDueAt.getTime()).toBe(fresh.dueAt.getTime())
      expect(log!.nextDueAt.getTime()).toBe(expected.dueAt.getTime())
      expect(log!.userId).toBe(userId)
      expect(fromSnapshot(log!.previousState, row.id)).toStrictEqual(fresh)
      expect(fromSnapshot(log!.nextState, row.id)).toStrictEqual(expected)
    },
  )

  it('a chain new → learning → review → relearning stays lossless and deterministic', async () => {
    const { card: fresh, row } = await insertNewCard(scheduler, schedulerVersion, userId, entryId)
    const steps: [Grade, Date][] = [
      [Rating.Again, NOW],
      [Rating.Good, at(0.01)],
      [Rating.Good, at(2)],
      [Rating.Easy, at(9)],
      [Rating.Again, at(60)],
      [Rating.Hard, at(60.02)],
    ]
    let inMemory = fresh
    const seenStates = new Set<number>([fresh.state as number])
    for (const [grade, now] of steps) {
      inMemory = scheduler.review({ card: asInput(inMemory), grade, now }).card
      await review(row.id, grade, now, scheduler, schedulerVersion)
      // Scheduling from the stored row gives exactly what scheduling in memory gives.
      expect(fromRow(await readCard(row.id))).toStrictEqual(inMemory)
      seenStates.add(inMemory.state as number)
    }
    expect([...seenStates].sort()).toEqual([0, 1, 2, 3]) // all four SRS states round-tripped
    const logs = await db.select().from(srsReviewLogs).where(eq(srsReviewLogs.cardId, row.id))
    expect(logs).toHaveLength(steps.length)
    expect(inMemory.lapses).toBeLessThanOrEqual(inMemory.reps) // srs_cards_counters holds under real FSRS
  })
})
