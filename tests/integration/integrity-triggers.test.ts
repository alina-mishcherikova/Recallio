// Integrity triggers (ADR 0001 D7, migration 0003), exercised as the runtime app role.
//   RC001: a user-scoped child row must belong to the owner of the entry's collection (rule 5)
//   RC002: collection languages are immutable once the collection has entries (DEC-001)
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, expectPgError, truncateAll } from './helpers/db'
import { createCard, createCollection, createEntry, createUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

let alice: string
let bob: string
let aliceEntry: string
let bobEntry: string

beforeEach(async () => {
  await truncateAll(migrator)
  alice = await createUser(app)
  bob = await createUser(app)
  aliceEntry = await createEntry(app, await createCollection(app, alice))
  bobEntry = await createEntry(app, await createCollection(app, bob))
})

describe("rows for user B on user A's entry are rejected (RC001)", () => {
  it('srs_cards', async () => {
    await expectPgError(createCard(app, { userId: bob, entryId: aliceEntry }), { code: 'RC001' })
    await createCard(app, { userId: alice, entryId: aliceEntry })
  })

  it('practice_attempts', async () => {
    const insert = (userId: string, entryId: string) =>
      app`insert into practice_attempts (user_id, entry_id, exercise_type, direction, source_mode,
                                         submitted_answer, is_correct, session_id, expected_answer, entry_revision)
          values (${userId}, ${entryId}, 'typing', 'production', 'typing', 'x', false, ${randomUUID()}, 'le chat', 1)`
    await expectPgError(insert(bob, aliceEntry), { code: 'RC001' })
    await insert(alice, aliceEntry)
  })

  it('answer_change_log', async () => {
    const insert = (userId: string, entryId: string) =>
      app`insert into answer_change_log (answer_id, entry_id, user_id, action, after)
          values (${randomUUID()}, ${entryId}, ${userId}, 'create', ${app.json({ a: 1 })})`
    await expectPgError(insert(bob, aliceEntry), { code: 'RC001' })
    await insert(alice, aliceEntry)
  })

  it('answer_flags; owner and entry are not updatable afterwards (column grants)', async () => {
    const insert = (userId: string, entryId: string) =>
      app<{ id: string }[]>`insert into answer_flags (user_id, entry_id, direction, submitted_answer)
          values (${userId}, ${entryId}, 'production', 'x') returning id`
    await expectPgError(insert(bob, aliceEntry), { code: 'RC001' })
    const [flag] = await insert(alice, aliceEntry)
    await expectPgError(app`update answer_flags set user_id = ${bob} where id = ${flag!.id}`, {
      code: '42501',
    })
    await expectPgError(app`update answer_flags set entry_id = ${bobEntry} where id = ${flag!.id}`, {
      code: '42501',
    })
    await app`update answer_flags set status = 'approved' where id = ${flag!.id}`
  })

  it('a missing entry is still reported by the foreign key (23503), not RC001', async () => {
    await expectPgError(createCard(app, { userId: alice, entryId: randomUUID() }), {
      code: '23503',
      constraint: 'srs_cards_entry_id_vocabulary_entries_id_fk',
    })
  })
})

describe('collection languages are immutable once entries exist (RC002)', () => {
  it('rejects a language change on a collection with entries', async () => {
    const [entry] = await app<{ collection_id: string }[]>`
      select collection_id from vocabulary_entries where id = ${aliceEntry}`
    for (const change of [{ native_language: 'de' }, { target_language: 'de' }]) {
      await expectPgError(app`update collections set ${app(change)} where id = ${entry!.collection_id}`, {
        code: 'RC002',
      })
    }
  })

  it('allows other edits, and language changes while the collection is empty', async () => {
    const [entry] = await app<{ collection_id: string }[]>`
      select collection_id from vocabulary_entries where id = ${aliceEntry}`
    await app`update collections set title = 'Renamed', native_language = native_language
              where id = ${entry!.collection_id}`

    const empty = await createCollection(app, alice)
    await app`update collections set native_language = 'de' where id = ${empty}`
    const [row] = await app`select native_language from collections where id = ${empty}`
    expect(row).toEqual({ native_language: 'de' })
  })
})
