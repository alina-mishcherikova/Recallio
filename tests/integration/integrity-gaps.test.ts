// Gaps from the LEX-002 tester review, now fixed (they were `it.fails` until the fix landed).
//
// Re-parenting an entry or a collection across users (RC001 bypass) is covered by
// ownership.security.test.ts (security finding H1). This file covers the language side.
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, pgError, truncateAll } from './helpers/db'
import { createAnswer, createCard, createCollection, createEntry, createUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

let alice: string
let aliceEntry: string

beforeEach(async () => {
  await truncateAll(migrator)
  alice = await createUser(app)
  aliceEntry = await createEntry(
    app,
    await createCollection(app, alice, { nativeLanguage: 'en', targetLanguage: 'fr' }),
  )
  await createCard(app, { userId: alice, entryId: aliceEntry })
})

// RC002 (migration 0003) only fires on UPDATE OF collections.native_language/target_language. Moving
// the entry instead (vocabulary_entries.collection_id is app-updatable) changes the language pair under
// its existing cards and answers just the same (spec §14.2, DEC-001).
describe('language immutability (RC002) cannot be bypassed by moving the entry', () => {
  it('moving an entry with cards into a collection with another language pair is rejected', async () => {
    const reversed = await createCollection(app, alice, { nativeLanguage: 'fr', targetLanguage: 'en' })
    await app`update vocabulary_entries set collection_id = ${reversed} where id = ${aliceEntry}`.catch(
      () => {},
    )
    const [row] = await app`
      select c.native_language, c.target_language from vocabulary_entries e
        join collections c on c.id = e.collection_id where e.id = ${aliceEntry}`
    expect(row, 'the entry and its cards silently switched to fr→en').toEqual({
      native_language: 'en',
      target_language: 'fr',
    })
  })
})

// accepted_answers.language only checks the format. An answer in a language outside the collection's
// pair can never be matched by either direction, so it is dead data (US-VOC-04 "associated with the
// appropriate language"). Enforcing it in the DB is a design choice: this documents the gap.
describe("accepted answer language belongs to the collection's pair", () => {
  it("an answer in a language outside the collection's pair is rejected", async () => {
    const error = await pgError(createAnswer(app, { entryId: aliceEntry, language: 'de' }))
    expect(error.code).toMatch(/^(23514|RC\d{3})$/)
  })
})
