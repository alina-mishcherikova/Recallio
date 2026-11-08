// Synonyms and sentence examples (ADR 0001 §2.3, spec US-MCQ-02, US-CTX-01, §14.1), plus the
// duplicate rules for accepted answers and open flags (tester L3). Run as the runtime app role.
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, count, expectPgError, truncateAll } from './helpers/db'
import {
  EXAMPLE_SENTENCE,
  createAnswer,
  createCollection,
  createEntry,
  createExample,
  createMeaning,
  createSynonym,
  createUser,
} from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

let userId: string
let entryId: string
let meaningId: string

beforeEach(async () => {
  await truncateAll(migrator)
  userId = await createUser(app)
  entryId = await createEntry(
    app,
    await createCollection(app, userId, { nativeLanguage: 'en', targetLanguage: 'fr' }),
  )
  meaningId = await createMeaning(app, entryId)
})

describe.each([
  ['vocabulary_synonyms', createSynonym],
  ['sentence_examples', createExample],
] as const)('%s', (table, create) => {
  it('is attached to an entry, optionally to one of its meanings, and starts pending', async () => {
    await create(app, { entryId })
    const id = await create(app, { entryId, meaningId })
    const [row] = await app`select meaning_id, approval_status from ${app(table)} where id = ${id}`
    expect(row).toEqual({ meaning_id: meaningId, approval_status: 'pending' })
  })

  it('rejects a meaning of another entry (composite FK)', async () => {
    const otherEntry = await createEntry(app, await createCollection(app, userId))
    const foreignMeaning = await createMeaning(app, otherEntry)
    await expectPgError(create(app, { entryId, meaningId: foreignMeaning }), {
      code: '23503',
      constraint: `${table}_meaning_entry_fk`,
    })
  })

  it("rejects a language outside the collection's pair (RC003), on insert and update", async () => {
    await expectPgError(create(app, { entryId, language: 'de' }), { code: 'RC003' })
    const id = await create(app, { entryId, language: 'en' })
    await expectPgError(app`update ${app(table)} set language = 'de' where id = ${id}`, {
      code: 'RC003',
    })
  })

  it('rejects a badly formatted language with the CHECK (23514)', async () => {
    await expectPgError(create(app, { entryId, language: 'FR' }), {
      code: '23514',
      constraint: `${table}_language_code`,
    })
  })

  it('cannot be moved to another entry (no UPDATE on entry_id)', async () => {
    const id = await create(app, { entryId })
    const otherEntry = await createEntry(app, await createCollection(app, userId))
    await expectPgError(app`update ${app(table)} set entry_id = ${otherEntry} where id = ${id}`, {
      code: '42501',
    })
  })

  it('can be approved, and is removed with its meaning and its entry', async () => {
    const id = await create(app, { entryId, meaningId })
    await app`update ${app(table)} set approval_status = 'approved' where id = ${id}`
    const loose = await create(app, { entryId })
    await app`delete from vocabulary_meanings where id = ${meaningId}`
    expect(await count(app, table)).toBe(1)
    await app`delete from vocabulary_entries where id = ${entryId}`
    expect(await count(app, table)).toBe(0)
    expect(loose).toBeTruthy()
  })
})

describe('synonym duplicates', () => {
  it('one synonym per entry, language and normalized text', async () => {
    await createSynonym(app, { entryId, text: 'Le Matou' })
    await expectPgError(createSynonym(app, { entryId, text: 'le matou' }), {
      code: '23505',
      constraint: 'vocabulary_synonyms_entry_language_text_key',
    })
  })
})

describe('sentence example slots', () => {
  const insert = (slots: unknown, sentence = EXAMPLE_SENTENCE) =>
    app`insert into sentence_examples (entry_id, language, sentence, target_answer, slots)
        values (${entryId}, 'fr', ${sentence}, 'Le chat', ${app.json(slots as never)})`

  it('accepts several well-formed slots', async () => {
    await insert([
      { start: 0, end: 7, answer: 'Le chat' },
      { start: 8, end: 12, answer: 'dort' },
    ])
  })

  it.each([
    ['not an array', { start: 0, end: 7, answer: 'x' }],
    ['empty', []],
    ['more than 10', Array.from({ length: 11 }, () => ({ start: 0, end: 1, answer: 'L' }))],
    ['not an object', ['Le chat']],
    ['missing end', [{ start: 0, answer: 'Le chat' }]],
    ['string offset', [{ start: '0', end: 7, answer: 'Le chat' }]],
    ['fractional offset', [{ start: 0.5, end: 7, answer: 'Le chat' }]],
    ['negative start', [{ start: -1, end: 7, answer: 'Le chat' }]],
    ['end before start', [{ start: 5, end: 5, answer: 'Le chat' }]],
    ['end past the sentence', [{ start: 0, end: 999, answer: 'Le chat' }]],
    ['blank answer', [{ start: 0, end: 7, answer: '  ' }]],
    ['missing answer', [{ start: 0, end: 7 }]],
  ])('rejects slots that are %s', async (_label, slots) => {
    await expectPgError(insert(slots), {
      code: '23514',
      constraint: 'sentence_examples_slots_format',
    })
  })
})

describe('accepted answer and flag duplicates (tester L3)', () => {
  it('one accepted answer per entry, language and normalized text', async () => {
    await createAnswer(app, { entryId, text: 'Le chat' })
    await createAnswer(app, { entryId, language: 'en', text: 'Le chat' }) // other language: fine
    await expectPgError(createAnswer(app, { entryId, text: 'LE CHAT' }), {
      code: '23505',
      constraint: 'accepted_answers_entry_language_text_key',
    })
  })

  it("rejects an answer outside the collection's pair (RC003), also on update", async () => {
    const id = await createAnswer(app, { entryId, language: 'en' })
    await expectPgError(app`update accepted_answers set language = 'de' where id = ${id}`, {
      code: 'RC003',
    })
  })

  it('one open flag per user, entry, direction and answer; resolved flags are history', async () => {
    const flag = () =>
      app<{ id: string }[]>`
        insert into answer_flags (user_id, entry_id, direction, submitted_answer)
        values (${userId}, ${entryId}, 'production', 'la chatte') returning id`
    const [first] = await flag()
    await expectPgError(flag(), { code: '23505', constraint: 'answer_flags_open_key' })
    await app`update answer_flags set status = 'rejected' where id = ${first!.id}`
    await flag() // a new open flag after the first was resolved
    expect(await count(app, 'answer_flags')).toBe(2)
  })

  it('an entry needs its normalized target expression (CSV duplicate lookup, tester L4)', async () => {
    const collectionId = await createCollection(app, userId)
    await expectPgError(
      app`insert into vocabulary_entries (collection_id, target_expression, normalized_target_expression, native_expression)
          values (${collectionId}, 'Le chat', '', 'the cat')`,
      { code: '23514', constraint: 'vocabulary_entries_normalized_target_len' },
    )
  })
})
