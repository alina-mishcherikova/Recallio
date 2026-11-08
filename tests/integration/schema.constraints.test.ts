// Schema constraints (ADR 0001 §6.3), exercised as the runtime app role.
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { languageCodeSchema } from '../../shared/constants/languages'
import { connectAs, count, expectPgError, pgError, truncateAll, waitForLockWait } from './helpers/db'
import {
  SCHEDULER_VERSION,
  T0,
  applyReview,
  createAnswer,
  createCard,
  createCollection,
  createEntry,
  createMeaning,
  createUser,
  insertLog,
  reviewCard,
} from './helpers/factories'

const app = connectAs('app')
const app2 = connectAs('app') // independent pool for concurrent transactions
const migrator = connectAs('migrator')

let userId: string
let collectionId: string
let entryId: string

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  collectionId = await createCollection(app, userId)
  entryId = await createEntry(app, collectionId)
})

describe('cards are unique per user, entry and direction (C1, US-SRS-02)', () => {
  it('rejects a second card for the same direction and allows the other direction', async () => {
    await createCard(app, { userId, entryId, direction: 'recognition' })
    await expectPgError(createCard(app, { userId, entryId, direction: 'recognition' }), {
      code: '23505',
      constraint: 'srs_cards_user_entry_direction_key',
    })
    await createCard(app, { userId, entryId, direction: 'production' })
    expect(await count(app, 'srs_cards')).toBe(2)
  })
})

describe('client_review_id is unique per card (C2, US-SRS-03, security L4)', () => {
  it('rejects a duplicate submission for the same card', async () => {
    const a = await createCard(app, { userId, entryId, direction: 'recognition' })
    const clientReviewId = randomUUID()
    await reviewCard(app, a.id, {}, { clientReviewId })
    await expectPgError(reviewCard(app, a.id, {}, { clientReviewId }), {
      code: '23505',
      constraint: 'srs_review_logs_card_client_review_id_key',
    })
    expect(await count(app, 'srs_review_logs')).toBe(1)
  })

  it("does not let one card's (or user's) client id block another card", async () => {
    const a = await createCard(app, { userId, entryId, direction: 'recognition' })
    const otherUser = await createUser(app)
    const otherEntry = await createEntry(app, await createCollection(app, otherUser))
    const b = await createCard(app, { userId: otherUser, entryId: otherEntry })
    const clientReviewId = randomUUID()
    await reviewCard(app, a.id, {}, { clientReviewId })
    await reviewCard(app, b.id, {}, { clientReviewId })
    expect(await count(app, 'srs_review_logs')).toBe(2)
  })

  it('rejects a concurrent duplicate for the same card on a second connection', async () => {
    const a = await createCard(app, { userId, entryId, direction: 'recognition' })
    const clientReviewId = randomUUID()

    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let firstApplied!: () => void
    const applied = new Promise<void>((resolve) => (firstApplied = resolve))

    const first = app.begin(async (tx) => {
      await applyReview(tx, a.id, {}, { clientReviewId })
      firstApplied()
      await held // keep the transaction open while the second one inserts
    })
    await applied
    const second = app2.begin((tx) => applyReview(tx, a.id, {}, { clientReviewId }))
    try {
      await waitForLockWait(app)
    } finally {
      release()
    }

    await first
    const error = await pgError(second)
    expect(error.code).toBe('23505')
    expect(error.constraint_name).toBe('srs_review_logs_card_client_review_id_key')
    expect(await count(app, 'srs_review_logs')).toBe(1)
  })
})

describe('collection languages (C3, C4, US-VOC-01, D5)', () => {
  it('rejects native = target', async () => {
    await expectPgError(createCollection(app, userId, { nativeLanguage: 'fr', targetLanguage: 'fr' }), {
      code: '23514',
      constraint: 'collections_languages_differ',
    })
  })

  it.each(['EN', 'fra', '', 'e1', 'é'])('rejects the badly formatted code %j everywhere', async (code) => {
    await expectPgError(createUser(app, { nativeLanguage: code }), {
      code: '23514',
      constraint: 'users_native_language_code',
    })
    await expectPgError(createCollection(app, userId, { nativeLanguage: code, targetLanguage: 'fr' }), {
      code: '23514',
      constraint: 'collections_native_language_code',
    })
    await expectPgError(createCollection(app, userId, { nativeLanguage: 'en', targetLanguage: code }), {
      code: '23514',
      constraint: 'collections_target_language_code',
    })
    await expectPgError(createAnswer(app, { entryId, language: code }), {
      code: '23514',
      constraint: 'accepted_answers_language_code',
    })
  })

  it('checks only the format: "de" is accepted by the DB and rejected by the Zod allow-list', async () => {
    await createCollection(app, userId, { nativeLanguage: 'de', targetLanguage: 'fr' })
    expect(languageCodeSchema.safeParse('de').success).toBe(false)
  })
})

describe('users', () => {
  it('emails are unique case-insensitively (C5)', async () => {
    await createUser(app, { email: 'A@x.fr' })
    await expectPgError(createUser(app, { email: 'a@x.fr' }), {
      code: '23505',
      constraint: 'users_email_key',
    })
  })

  it.each([
    ['daily_new_limit', -1, 'users_daily_new_limit_range'],
    ['daily_new_limit', 1001, 'users_daily_new_limit_range'],
    ['daily_review_limit', 10001, 'users_daily_review_limit_range'],
  ])('rejects %s = %d (C13)', async (column, value, constraint) => {
    await expectPgError(app`update users set ${app(column)} = ${value} where id = ${userId}`, {
      code: '23514',
      constraint,
    })
  })
})

describe('accepted answers', () => {
  it('a meaning must belong to the same entry (C6, US-VOC-04)', async () => {
    const otherEntry = await createEntry(app, collectionId)
    const foreignMeaning = await createMeaning(app, otherEntry)
    await expectPgError(createAnswer(app, { entryId, meaningId: foreignMeaning }), {
      code: '23503',
      constraint: 'accepted_answers_meaning_entry_fk',
    })
  })

  it('only one primary answer per entry and language (C7)', async () => {
    await createAnswer(app, { entryId, isPrimary: true })
    await createAnswer(app, { entryId, isPrimary: false })
    await createAnswer(app, { entryId, language: 'en', isPrimary: true })
    await expectPgError(createAnswer(app, { entryId, isPrimary: true }), {
      code: '23505',
      constraint: 'accepted_answers_one_primary_idx',
    })
  })

  it('an empty normalized answer is never stored (C8, CLAUDE.md rule 3)', async () => {
    await expectPgError(
      app`insert into accepted_answers (entry_id, language, answer_text, normalized_text)
          values (${entryId}, 'fr', ' ', '')`,
      { code: '23514', constraint: 'accepted_answers_normalized_len' },
    )
  })
})

describe('SRS values (C9, C10)', () => {
  // Values a JSON snapshot can carry reach the CHECKs through the normal review path.
  it.each([
    ['stability = -1', { stability: -1 }, 'srs_cards_stability_finite'],
    ['stability_fast = -1', { stability_fast: -1 }, 'srs_cards_stability_fast_finite'],
    ['difficulty = 11', { difficulty: 11 }, 'srs_cards_difficulty_range'],
    ['scheduled_days = -1', { scheduled_days: -1 }, 'srs_cards_scheduled_days_finite'],
  ])('a reviewed update with %s fails its CHECK', async (_label, patch, constraint) => {
    const card = await createCard(app, { userId, entryId })
    await expectPgError(reviewCard(app, card.id, patch), { code: '23514', constraint })
  })

  // NaN/Infinity can't be written to a JSON snapshot, and lapses > reps contradicts the one-review rule,
  // so the guard already rejects them (SR002). The CHECKs are still verified as the owner, with the
  // guard disabled inside a transaction that always rolls back.
  it.each([
    ['stability = NaN', { stability: Number.NaN }, 'srs_cards_stability_finite'],
    ['stability = Infinity', { stability: Number.POSITIVE_INFINITY }, 'srs_cards_stability_finite'],
    ['stability_fast = NaN', { stability_fast: Number.NaN }, 'srs_cards_stability_fast_finite'],
    ['scheduled_days = NaN', { scheduled_days: Number.NaN }, 'srs_cards_scheduled_days_finite'],
    ['lapses > reps', { lapses: 5 }, 'srs_cards_counters'],
  ])('%s: rejected by the guard (SR002) and by its CHECK', async (_label, patch, constraint) => {
    const card = await createCard(app, { userId, entryId })
    await expectPgError(reviewCard(app, card.id, patch), { code: 'SR002' })
    await expectPgError(
      migrator.begin(async (tx) => {
        await tx`alter table srs_cards disable trigger srs_cards_guard_update`
        await tx`update srs_cards set ${tx(patch)} where id = ${card.id}`
        throw new Error('the CHECK did not fire') // never commit the disabled trigger
      }),
      { code: '23514', constraint },
    )
  })

  it.each([
    ['trailing space', 'ts-fsrs@6.0.0/fsrs-7 '],
    ['no package', 'fsrs-7'],
    ['other lib', 'other@1.0.0/fsrs-7'],
  ])('scheduler_version must match ts-fsrs@x.y.z/fsrs-n (%s)', async (_label, version) => {
    await expectPgError(
      app`insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
          values (${userId}, ${entryId}, 'recognition', ${T0}, ${version})`,
      { code: '23514', constraint: 'srs_cards_scheduler_version_format' },
    )
  })

  it('a log with next_due_at before reviewed_at fails', async () => {
    const card = await createCard(app, { userId, entryId })
    await expectPgError(
      insertLog(app, {
        cardId: card.id,
        previousDueAt: T0,
        reviewedAt: T0,
        nextDueAt: new Date(T0.getTime() - 1),
      }),
      { code: '23514', constraint: 'srs_review_logs_due_order' },
    )
  })

  it('a log rating outside again/hard/good/easy is invalid, including manual (D2)', async () => {
    const card = await createCard(app, { userId, entryId })
    for (const rating of ['manual', 'perfect']) {
      await expectPgError(reviewCard(app, card.id, {}, { rating }), { code: '22P02' })
    }
  })
})

describe('history and practice rows', () => {
  it('a matched answer implies a correct attempt (C11)', async () => {
    const answerId = await createAnswer(app, { entryId })
    await expectPgError(
      app`insert into practice_attempts (user_id, entry_id, exercise_type, direction, source_mode,
                                         submitted_answer, matched_answer_id, is_correct, session_id, expected_answer, entry_revision)
          values (${userId}, ${entryId}, 'typing', 'production', 'typing', 'x', ${answerId}, false, ${randomUUID()}, 'le chat', 1)`,
      { code: '23514', constraint: 'practice_attempts_match_implies_correct' },
    )
  })

  it.each([
    ['create with before', 'create', { a: 1 }, { a: 2 }],
    ['create without after', 'create', null, null],
    ['update without before', 'update', null, { a: 2 }],
    ['update without after', 'update', { a: 1 }, null],
    ['delete with after', 'delete', { a: 1 }, { a: 2 }],
    ['delete without before', 'delete', null, null],
  ])('answer_change_log rejects %s (C12)', async (_label, action, before, after) => {
    await expectPgError(
      app`insert into answer_change_log (answer_id, entry_id, user_id, action, before, after)
          values (${randomUUID()}, ${entryId}, ${userId}, ${action},
                  ${before && app.json(before)}, ${after && app.json(after)})`,
      { code: '23514', constraint: 'answer_change_log_shape' },
    )
  })

  it('JSON columns must have the right shape (C14)', async () => {
    await expectPgError(
      app`update collections set normalization = ${app.json([1])} where id = ${collectionId}`,
      { code: '23514', constraint: 'collections_normalization_object' },
    )
    await expectPgError(
      app`insert into vocabulary_meanings (entry_id, grammatical_metadata) values (${entryId}, ${app.json('x')})`,
      { code: '23514', constraint: 'vocabulary_meanings_metadata_object' },
    )
    const card = await createCard(app, { userId, entryId })
    await expectPgError(reviewCard(app, card.id, {}, { previousState: [1] }), {
      code: '23514',
      constraint: 'srs_review_logs_states_objects',
    })
    await expectPgError(
      app`insert into practice_attempts (user_id, entry_id, exercise_type, direction, source_mode,
                                         submitted_answer, is_correct, diff, session_id, expected_answer, entry_revision)
          values (${userId}, ${entryId}, 'typing', 'production', 'typing', 'x', false, ${app.json({ a: 1 })}, ${randomUUID()}, 'le chat', 1)`,
      { code: '23514', constraint: 'practice_attempts_diff_array' },
    )
  })

  it('rejects unknown enum values (C15)', async () => {
    await expectPgError(
      app`insert into srs_cards (user_id, entry_id, direction, due_at, scheduler_version)
          values (${userId}, ${entryId}, 'both', ${T0}, ${SCHEDULER_VERSION})`,
      { code: '22P02' },
    )
  })
})
