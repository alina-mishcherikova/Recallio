// Test factories (ADR 0001 §6.2). Every table in `public` must be reachable from here: the cascade
// test fails if a table is left unseeded.
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { Q } from './db'

export const SCHEDULER_VERSION = 'ts-fsrs@6.0.0/fsrs-7'
export const T0 = new Date('2026-01-01T00:00:00.000Z')
const DAY = 86_400_000

type Row = Record<string, unknown>
type Direction = 'recognition' | 'production'

export interface CardRow {
  id: string
  user_id: string
  entry_id: string
  direction: Direction
  state: string
  schedule_status: string
  due_at: Date
  stability: number
  stability_fast: number | null
  difficulty: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  last_review_at: Date | null
  scheduler_version: string
  updated_at: Date
}

/** The 12 scheduling columns the guard protects (and the app role may UPDATE). */
export const SCHEDULING_COLUMNS = [
  'state',
  'schedule_status',
  'due_at',
  'stability',
  'stability_fast',
  'difficulty',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'last_review_at',
  'scheduler_version',
] as const

const json = (sql: Q, value: unknown) => sql.json(value as postgres.JSONValue)

export async function createUser(sql: Q, o: { email?: string; nativeLanguage?: string } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, password_hash, native_language)
    values (${o.email ?? `${randomUUID()}@example.test`}, 'scrypt:not-a-real-hash', ${o.nativeLanguage ?? 'en'})
    returning id`
  return row!.id
}

export async function createCollection(
  sql: Q,
  ownerId: string,
  o: { nativeLanguage?: string; targetLanguage?: string; title?: string } = {},
) {
  const [row] = await sql<{ id: string }[]>`
    insert into collections (owner_id, title, native_language, target_language)
    values (${ownerId}, ${o.title ?? 'Animals'}, ${o.nativeLanguage ?? 'en'}, ${o.targetLanguage ?? 'fr'})
    returning id`
  return row!.id
}

export async function createEntry(sql: Q, collectionId: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into vocabulary_entries (collection_id, target_expression, normalized_target_expression, native_expression)
    values (${collectionId}, 'le chat', 'le chat', 'the cat')
    returning id`
  return row!.id
}

export async function createMeaning(sql: Q, entryId: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into vocabulary_meanings (entry_id, definition) values (${entryId}, 'small domestic feline')
    returning id`
  return row!.id
}

let answerSeq = 0

export async function createAnswer(
  sql: Q,
  o: {
    entryId: string
    meaningId?: string | null
    language?: string
    isPrimary?: boolean
    text?: string
  },
) {
  // Unique per call by default: (entry_id, language, normalized_text) is unique.
  const text = o.text ?? `le chat ${++answerSeq}`
  const [row] = await sql<{ id: string }[]>`
    insert into accepted_answers (entry_id, meaning_id, language, answer_text, normalized_text, is_primary)
    values (${o.entryId}, ${o.meaningId ?? null}, ${o.language ?? 'fr'}, ${text}, ${text.toLowerCase()}, ${o.isPrimary ?? false})
    returning id`
  return row!.id
}

export async function createSynonym(
  sql: Q,
  o: { entryId: string; meaningId?: string | null; language?: string; text?: string },
) {
  const text = o.text ?? `le matou ${++answerSeq}`
  const [row] = await sql<{ id: string }[]>`
    insert into vocabulary_synonyms (entry_id, meaning_id, language, text, normalized_text)
    values (${o.entryId}, ${o.meaningId ?? null}, ${o.language ?? 'fr'}, ${text}, ${text.toLowerCase()})
    returning id`
  return row!.id
}

export const EXAMPLE_SENTENCE = 'Le chat dort sur le canapé.'
export const EXAMPLE_SLOTS = [{ start: 0, end: 7, answer: 'Le chat' }]

export async function createExample(
  sql: Q,
  o: { entryId: string; meaningId?: string | null; language?: string; slots?: unknown },
) {
  const [row] = await sql<{ id: string }[]>`
    insert into sentence_examples (entry_id, meaning_id, language, sentence, translation, target_answer, slots)
    values (${o.entryId}, ${o.meaningId ?? null}, ${o.language ?? 'fr'}, ${EXAMPLE_SENTENCE},
            'The cat sleeps on the sofa.', 'Le chat', ${json(sql, o.slots ?? EXAMPLE_SLOTS)})
    returning id`
  return row!.id
}

export async function createAttempt(
  sql: Q,
  o: {
    userId: string
    entryId: string
    matchedAnswerId?: string | null
    isCorrect?: boolean
    entryRevision?: number
  },
) {
  const [row] = await sql<{ id: string }[]>`
    insert into practice_attempts (user_id, entry_id, exercise_type, direction, source_mode, submitted_answer,
                                   expected_answer, entry_revision, matched_answer_id, is_correct, session_id)
    values (${o.userId}, ${o.entryId}, 'typing', 'production', 'typing', 'le chat', 'le chat',
            ${o.entryRevision ?? 1}, ${o.matchedAnswerId ?? null}, ${o.isCorrect ?? false}, ${randomUUID()})
    returning id`
  return row!.id
}

/** A pristine card, as the vocabulary service will create it. */
export async function createCard(
  sql: Q,
  o: { userId: string; entryId: string; direction?: Direction; dueAt?: Date },
) {
  const [row] = await sql<CardRow[]>`
    insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
    values (${o.userId}, ${o.entryId}, ${o.direction ?? 'recognition'}, ${o.dueAt ?? T0}, ${SCHEDULER_VERSION})
    returning *`
  return row!
}

export async function getCard(sql: Q, id: string) {
  const [row] = await sql<CardRow[]>`select * from srs_cards where id = ${id}`
  return row!
}

export interface LogInput {
  cardId: string
  /** Defaults to the card's user (looked up in the same statement). */
  userId?: string
  entryRevision?: number
  previousDueAt: Date
  nextDueAt: Date
  reviewedAt?: Date
  clientReviewId?: string
  rating?: string
  schedulerVersion?: string
  previousState?: unknown
  nextState?: unknown
}

export async function insertLog(sql: Q, o: LogInput) {
  const [row] = await sql<{ id: string }[]>`
    insert into srs_review_logs (card_id, user_id, entry_revision, client_review_id, rating, reviewed_at,
                                 previous_state, next_state, previous_due_at, next_due_at, scheduler_version)
    values (${o.cardId}, coalesce(${o.userId ?? null}::uuid, (select user_id from srs_cards where id = ${o.cardId})), ${o.entryRevision ?? 1}, ${o.clientReviewId ?? randomUUID()}, ${o.rating ?? 'good'},
            ${o.reviewedAt ?? o.previousDueAt}, ${json(sql, o.previousState ?? {})},
            ${json(sql, o.nextState ?? {})}, ${o.previousDueAt}, ${o.nextDueAt},
            ${o.schedulerVersion ?? SCHEDULER_VERSION})
    returning id`
  return row!.id
}

const iso = (d: unknown) => (d === null || d === undefined ? null : (d as Date).toISOString())

/**
 * The log snapshot format (server/db/schema/srs.ts SRS_SNAPSHOT_KEYS): the 12 scheduling columns as
 * camelCase keys, ISO timestamps. The guard requires previous_state / next_state to equal the card.
 */
export function toSnapshot(card: Row): Record<string, unknown> {
  return {
    state: card.state,
    scheduleStatus: card.schedule_status,
    dueAt: iso(card.due_at),
    stability: card.stability,
    stabilityFast: card.stability_fast,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReviewAt: iso(card.last_review_at),
    schedulerVersion: card.scheduler_version,
  }
}

/** A plausible post-review card (FSRS-7 "good" on a new card). */
export function nextCardState(card: CardRow, patch: Row = {}): Row {
  const reviewedAt = card.due_at
  return {
    state: 'review',
    schedule_status: 'review',
    due_at: new Date(reviewedAt.getTime() + 4 * DAY),
    stability: 3.9221,
    stability_fast: 3.13768,
    difficulty: 3.53072398,
    scheduled_days: 4.777721809269842,
    learning_steps: 0,
    reps: card.reps + 1,
    lapses: card.lapses,
    last_review_at: reviewedAt,
    scheduler_version: card.scheduler_version,
    ...patch,
  }
}

/**
 * Applies one review inside an existing transaction, in the order the review service must use
 * (ADR 0001 §3.3): lock the card, insert the log (opens the grant), update the card (consumes it).
 */
export async function applyReview(tx: Q, cardId: string, patch: Row = {}, log: Partial<LogInput> = {}) {
  const [card] = await tx<CardRow[]>`select * from srs_cards where id = ${cardId} for update`
  const next = nextCardState(card!, patch)
  const logId = await insertLog(tx, {
    cardId,
    previousDueAt: card!.due_at,
    nextDueAt: next.due_at as Date,
    reviewedAt: card!.due_at,
    schedulerVersion: next.scheduler_version as string,
    previousState: toSnapshot(card as unknown as Row),
    nextState: toSnapshot({ ...card, ...next }),
    ...log,
  })
  await tx`update srs_cards set ${tx(next)} where id = ${cardId}`
  return { logId, next }
}

/** One complete review submission: a single top-level transaction. */
export function reviewCard(sql: postgres.Sql, cardId: string, patch: Row = {}, log: Partial<LogInput> = {}) {
  return sql.begin((tx) => applyReview(tx, cardId, patch, log))
}

export interface SeededUser {
  userId: string
  collectionId: string
  entryId: string
  meaningId: string
  answerId: string
  cards: { recognition: CardRow; production: CardRow }
}

/**
 * One user with at least one row in every `public` table: collection, entry, meaning, answer,
 * change log, flag, two cards (one reviewed, so it has a log), a practice attempt, a synonym and a
 * sentence example.
 */
export async function seedUser(sql: postgres.Sql): Promise<SeededUser> {
  const userId = await createUser(sql)
  const collectionId = await createCollection(sql, userId)
  const entryId = await createEntry(sql, collectionId)
  const meaningId = await createMeaning(sql, entryId)
  const answerId = await createAnswer(sql, { entryId, meaningId, isPrimary: true })
  await sql`
    insert into answer_change_log (answer_id, entry_id, user_id, action, after)
    values (${answerId}, ${entryId}, ${userId}, 'create', ${json(sql, { answerText: 'Le chat' })})`
  await sql`
    insert into answer_flags (user_id, entry_id, direction, submitted_answer)
    values (${userId}, ${entryId}, 'production', 'la chatte')`
  const recognition = await createCard(sql, { userId, entryId, direction: 'recognition' })
  const production = await createCard(sql, { userId, entryId, direction: 'production' })
  await reviewCard(sql, recognition.id)
  await createAttempt(sql, { userId, entryId, matchedAnswerId: answerId, isCorrect: true })
  await createSynonym(sql, { entryId, meaningId })
  await createExample(sql, { entryId, meaningId })
  return {
    userId,
    collectionId,
    entryId,
    meaningId,
    answerId,
    cards: { recognition: await getCard(sql, recognition.id), production },
  }
}
