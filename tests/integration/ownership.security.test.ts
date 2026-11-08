// Ownership integrity at the DB layer (CLAUDE.md rule 5, ADR 0001 D7), run as the runtime app role.
// Each case was a known gap from the LEX-002 security review (`it.fails` until fixed).
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectAs, expectPgError, truncateAll } from './helpers/db'
import {
  createAnswer,
  createCard,
  createCollection,
  createEntry,
  createMeaning,
  createUser,
} from './helpers/factories'

const app = connectAs('app')
const app2 = connectAs('app') // independent pool for concurrent transactions
const migrator = connectAs('migrator')

let userA: string
let userB: string
let collectionA: string
let collectionB: string
let entryA: string
let entryB: string

beforeEach(async () => {
  await truncateAll(migrator)
  userA = await createUser(app)
  userB = await createUser(app)
  collectionA = await createCollection(app, userA)
  collectionB = await createCollection(app, userB)
  entryA = await createEntry(app, collectionA)
  entryB = await createEntry(app, collectionB)
  await createCard(app, { userId: userA, entryId: entryA })
  await createCard(app, { userId: userB, entryId: entryB })
})

// Gap 1 (review finding H1): parent/owner columns are updatable, so RC001 (insert-only) can be
// bypassed after the fact. User A's cards end up on an entry owned by B, or B's on A's. A later
// account deletion of one user then cascades into the other user's cards and review history.
describe('owner and parent columns are immutable for the app role', () => {
  it('collections.owner_id → 42501', async () => {
    await expectPgError(app`update collections set owner_id = ${userB} where id = ${collectionA}`, {
      code: '42501',
    })
  })

  it('vocabulary_entries.collection_id → 42501', async () => {
    await expectPgError(
      app`update vocabulary_entries set collection_id = ${collectionA} where id = ${entryB}`,
      { code: '42501' },
    )
  })

  it('vocabulary_meanings.entry_id → 42501', async () => {
    const meaning = await createMeaning(app, entryA)
    await expectPgError(app`update vocabulary_meanings set entry_id = ${entryB} where id = ${meaning}`, {
      code: '42501',
    })
  })

  it('accepted_answers.entry_id → 42501', async () => {
    const answer = await createAnswer(app, { entryId: entryA })
    await expectPgError(app`update accepted_answers set entry_id = ${entryB} where id = ${answer}`, {
      code: '42501',
    })
  })

  it('users.id → 42501', async () => {
    const lonely = await createUser(app)
    await expectPgError(app`update users set id = ${randomUUID()} where id = ${lonely}`, { code: '42501' })
  })

  it('re-parenting is denied, so deleting user A never touches user B (H1 fixed)', async () => {
    await expectPgError(
      app`update vocabulary_entries set collection_id = ${collectionA} where id = ${entryB}`,
      { code: '42501' },
    )
    await app`delete from users where id = ${userA}`
    const [left] = await app<
      { n: number }[]
    >`select count(*)::int as n from srs_cards where user_id = ${userB}`
    expect(left!.n).toBe(1)
  })
})

// Gap 2 (review finding L2): RC002 reads entries under the updater's snapshot, and the FK check on
// entry insert takes only FOR KEY SHARE on the collection, which does not conflict with a non-key
// UPDATE. So a language change and an entry insert never wait for each other.
describe('collection language change vs. concurrent entry insert (RC002)', () => {
  it('an entry insert waits for an uncommitted language change on its collection', async () => {
    const empty = await createCollection(app, userA, { title: 'Empty' })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let changed!: () => void
    const languageChanged = new Promise<void>((resolve) => (changed = resolve))
    const rollback = new Error('rollback')

    const t1 = app
      .begin(async (tx) => {
        await tx`update collections set target_language = 'de' where id = ${empty}`
        changed()
        await held
        throw rollback
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error
      })
    await languageChanged
    try {
      // Fixed behaviour: the insert blocks on the collection row, so lock_timeout fires (55P03).
      await expectPgError(
        app2.begin(async (tx) => {
          await tx`set local lock_timeout = '300ms'`
          await createEntry(tx, empty)
        }),
        { code: '55P03' },
      )
    } finally {
      release()
      await t1
    }
    expect(true).toBe(true)
  })
})
