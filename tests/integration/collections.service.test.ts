// I1–I6 (ADR 0003 §6.2): the collections service, called with a Drizzle instance on the
// least-privilege app role (no Nitro). Ownership, RC002, keyset paging, the D3 cap under
// concurrency, delete cascades, and archive semantics (D2).
import { drizzle } from 'drizzle-orm/postgres-js'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  setArchived,
  updateCollection,
} from '../../server/services/collections/collections.service'
import { toCollectionDto } from '../../server/services/collections/dto'
import { COLLECTION_LIMIT, collectionSchema } from '../../shared/schemas/collections'
import { connectAs, truncateAll, type Q } from './helpers/db'
import {
  createAttempt,
  createCard,
  createCollection as seedCollection,
  createEntry,
  createUser,
  reviewCard,
  seedUser,
} from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
// Own pool: drizzle() reconfigures the client's type parsers, which the raw factories rely on.
// Ten connections, so the parallel-create test really runs ten transactions at once.
const db = drizzle(connectAs('app', { max: 10 }), { schema })

const input = { title: 'Animals', nativeLanguage: 'en', targetLanguage: 'fr' } as const

beforeEach(() => truncateAll(migrator))

/** The full stored row as text (microseconds included): "byte-identical" comparisons. */
async function rowText(sql: Q, table: 'collections' | 'srs_cards' | 'srs_review_logs', where: string) {
  const rows =
    table === 'collections'
      ? await sql<{ t: string }[]>`select c::text as t from collections c where id = ${where}`
      : table === 'srs_cards'
        ? await sql<
            { t: string }[]
          >`select c::text as t from srs_cards c where entry_id = ${where} order by id`
        : await sql<{ t: string }[]>`
            select l::text as t from srs_review_logs l join srs_cards c on c.id = l.card_id
             where c.entry_id = ${where} order by l.id`
  return rows.map((r) => r.t)
}

async function ownedCount(userId: string): Promise<number> {
  const [row] = await migrator<
    { n: number }[]
  >`select count(*)::int as n from collections where owner_id = ${userId}`
  return row!.n
}

describe('ownership (I1)', () => {
  it("every service treats another user's collection as missing, and changes nothing", async () => {
    const alice = await createUser(app)
    const bob = await createUser(app)
    const created = await createCollection(db, alice, { ...input, topic: 'zoo' })
    if (!created.ok) throw new Error('create failed')
    const id = created.row.id
    await createEntry(app, id)
    const before = await rowText(migrator, 'collections', id)

    expect(await getCollection(db, bob, id)).toBeNull()
    expect(await updateCollection(db, bob, id, { title: 'Mine now' })).toEqual({
      ok: false,
      kind: 'not_found',
    })
    expect(await updateCollection(db, bob, id, { targetLanguage: 'en', nativeLanguage: 'fr' })).toEqual({
      ok: false,
      kind: 'not_found',
    })
    expect(await setArchived(db, bob, id, true)).toBeNull()
    expect(await setArchived(db, bob, id, false)).toBeNull()
    // Even with the right title: ownership comes first.
    expect(await deleteCollection(db, bob, id, 'Animals')).toEqual({ ok: false, kind: 'not_found' })
    expect(await listCollections(db, bob, { status: 'active', limit: 50 })).toEqual({
      ok: true,
      items: [],
      nextCursor: null,
    })
    expect(await listCollections(db, bob, { status: 'archived', limit: 50 })).toMatchObject({ items: [] })
    // Alice's id as Bob's cursor is rejected without revealing that it exists.
    expect(await listCollections(db, bob, { status: 'active', limit: 50, cursor: id })).toEqual({
      ok: false,
      kind: 'invalid_cursor',
    })

    expect(await rowText(migrator, 'collections', id)).toEqual(before)
    const own = await getCollection(db, alice, id)
    expect(own).toMatchObject({ id, ownerId: alice, title: 'Animals', entryCount: 1, archivedAt: null })
  })

  it('a missing user cannot create (no orphan, no FK error)', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000'
    expect(await createCollection(db, ghost, input)).toEqual({ ok: false, kind: 'user_missing' })
  })

  it('the row DTO parses strictly and carries no ownerId', async () => {
    const alice = await createUser(app)
    const created = await createCollection(db, alice, { ...input, description: 'line 1\nline 2' })
    if (!created.ok) throw new Error('create failed')
    const dto = toCollectionDto(created.row)
    expect(collectionSchema.parse(dto)).toEqual(dto)
    expect(JSON.stringify(dto)).not.toContain(alice)
    expect(dto).toMatchObject({ entryCount: 0, description: 'line 1\nline 2', topic: null })
  })
})

describe('language lock (I2, DEC-001)', () => {
  it('languages change freely with no entries, then RC002 → languages_locked', async () => {
    const alice = await createUser(app)
    const created = await createCollection(db, alice, input)
    if (!created.ok) throw new Error('create failed')
    const id = created.row.id

    const swapped = await updateCollection(db, alice, id, { nativeLanguage: 'fr', targetLanguage: 'en' })
    expect(swapped).toMatchObject({ ok: true, row: { nativeLanguage: 'fr', targetLanguage: 'en' } })

    await createEntry(app, id)
    expect(await updateCollection(db, alice, id, { nativeLanguage: 'en', targetLanguage: 'fr' })).toEqual({
      ok: false,
      kind: 'languages_locked',
    })
    // Unchanged languages are fine (RC002 fires only on IS DISTINCT FROM), and so is a rename.
    expect(
      await updateCollection(db, alice, id, { nativeLanguage: 'fr', targetLanguage: 'en' }),
    ).toMatchObject({
      ok: true,
    })
    expect(await updateCollection(db, alice, id, { title: 'Renamed' })).toMatchObject({
      ok: true,
      row: { title: 'Renamed', nativeLanguage: 'fr', targetLanguage: 'en', entryCount: 1 },
    })
  })

  it('a single-language change equal to the stored other language → languages_same (CHECK)', async () => {
    const alice = await createUser(app)
    const created = await createCollection(db, alice, input)
    if (!created.ok) throw new Error('create failed')
    expect(await updateCollection(db, alice, created.row.id, { targetLanguage: 'en' })).toEqual({
      ok: false,
      kind: 'languages_same',
    })
  })

  it('clears description and topic with null', async () => {
    const alice = await createUser(app)
    const created = await createCollection(db, alice, { ...input, description: 'd', topic: 't' })
    if (!created.ok) throw new Error('create failed')
    expect(
      await updateCollection(db, alice, created.row.id, { description: null, topic: null }),
    ).toMatchObject({
      ok: true,
      row: { description: null, topic: null },
    })
  })
})

describe('keyset pagination (I3)', () => {
  it('45 collections with an identical created_at → 20/20/5, no duplicates or gaps', async () => {
    const alice = await createUser(app)
    // One statement: now() is the same for every row, so only the id breaks ties.
    await app`
      insert into collections (owner_id, title, native_language, target_language)
      select ${alice}, 'C' || g, 'en', 'fr' from generate_series(1, 45) g`
    const [distinct] = await migrator<{ n: number }[]>`
      select count(distinct created_at)::int as n from collections where owner_id = ${alice}`
    expect(distinct!.n).toBe(1)

    const seen: string[] = []
    const sizes: number[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const result = await listCollections(db, alice, {
        status: 'active',
        limit: 20,
        ...(cursor && { cursor }),
      })
      if (!result.ok) throw new Error('invalid cursor')
      sizes.push(result.items.length)
      seen.push(...result.items.map((r) => r.id))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    expect(sizes).toEqual([20, 20, 5])
    expect(new Set(seen).size).toBe(45)
    const expected = await migrator<{ id: string }[]>`
      select id from collections where owner_id = ${alice} order by created_at desc, id desc`
    expect(seen).toEqual(expected.map((r) => r.id))
  })

  it('microsecond timestamps are ordered correctly across pages (no JS Date rounding)', async () => {
    const alice = await createUser(app)
    // Same millisecond, different microseconds.
    await migrator`
      insert into collections (owner_id, title, native_language, target_language, created_at)
      select ${alice}, 'C' || g, 'en', 'fr', timestamptz '2026-01-01 00:00:00.000' + g * interval '1 microsecond'
        from generate_series(1, 6) g`
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const result = await listCollections(db, alice, {
        status: 'active',
        limit: 2,
        ...(cursor && { cursor }),
      })
      if (!result.ok) throw new Error('invalid cursor')
      seen.push(...result.items.map((r) => r.title))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    expect(seen).toEqual(['C6', 'C5', 'C4', 'C3', 'C2', 'C1'])
  })

  it('status filters active vs archived; a deleted cursor → invalid_cursor', async () => {
    const alice = await createUser(app)
    const a = await seedCollection(app, alice, { title: 'A' })
    const b = await seedCollection(app, alice, { title: 'B' })
    await setArchived(db, alice, b, true)
    expect(
      (await listCollections(db, alice, { status: 'active', limit: 20 })) as { items: { id: string }[] },
    ).toMatchObject({
      items: [{ id: a }],
    })
    expect(await listCollections(db, alice, { status: 'archived', limit: 20 })).toMatchObject({
      items: [{ id: b }],
    })

    // A valid cursor at the end of the list is an empty last page, not an error.
    expect(await listCollections(db, alice, { status: 'active', limit: 20, cursor: a })).toEqual({
      ok: true,
      items: [],
      nextCursor: null,
    })
    await app`delete from collections where id = ${a}`
    expect(await listCollections(db, alice, { status: 'active', limit: 20, cursor: a })).toEqual({
      ok: false,
      kind: 'invalid_cursor',
    })
  })

  it('entryCount counts the entries of each collection', async () => {
    const alice = await createUser(app)
    const a = await seedCollection(app, alice, { title: 'A' })
    await createEntry(app, a)
    await createEntry(app, a)
    await seedCollection(app, alice, { title: 'B' })
    const result = await listCollections(db, alice, { status: 'active', limit: 20 })
    if (!result.ok) throw new Error('unexpected')
    expect(Object.fromEntries(result.items.map((r) => [r.title, r.entryCount]))).toEqual({ A: 2, B: 0 })
  })
})

describe(`per-user cap of ${COLLECTION_LIMIT} (I4, D3)`, () => {
  async function fill(userId: string, n: number) {
    await app`
      insert into collections (owner_id, title, native_language, target_language)
      select ${userId}, 'C' || g, 'en', 'fr' from generate_series(1, ${n}::int) g`
  }

  it('the 201st create is limit_reached; other users are not affected', async () => {
    const alice = await createUser(app)
    const bob = await createUser(app)
    await fill(alice, COLLECTION_LIMIT - 1)
    expect(await createCollection(db, alice, input)).toMatchObject({ ok: true })
    expect(await createCollection(db, alice, input)).toEqual({ ok: false, kind: 'limit_reached' })
    expect(await ownedCount(alice)).toBe(COLLECTION_LIMIT)
    expect(await createCollection(db, bob, input)).toMatchObject({ ok: true })
  })

  it('10 parallel creates at 195 never exceed 200', async () => {
    const alice = await createUser(app)
    await fill(alice, COLLECTION_LIMIT - 5)
    const results = await Promise.all(Array.from({ length: 10 }, () => createCollection(db, alice, input)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => !r.ok && r.kind === 'limit_reached')).toHaveLength(5)
    expect(await ownedCount(alice)).toBe(COLLECTION_LIMIT)
  })

  it('deleting one frees a slot', async () => {
    const alice = await createUser(app)
    await fill(alice, COLLECTION_LIMIT)
    expect(await createCollection(db, alice, input)).toEqual({ ok: false, kind: 'limit_reached' })
    const [one] = await app<{ id: string; title: string }[]>`
      select id, title from collections where owner_id = ${alice} limit 1`
    expect(await deleteCollection(db, alice, one!.id, one!.title)).toMatchObject({ ok: true })
    expect(await createCollection(db, alice, input)).toMatchObject({ ok: true })
  })
})

describe('delete (I5, D1)', () => {
  it("cascades below the collection; other collections' srs_* rows are byte-identical", async () => {
    const alice = await seedUser(app) // collection with entry, cards (one reviewed), attempt, ...
    const bob = await seedUser(app)

    // A second collection of Alice's with its own entry, cards, a review log and an attempt.
    const keep = await seedCollection(app, alice.userId, { title: 'Keep' })
    const keepEntry = await createEntry(app, keep)
    const card = await createCard(app, { userId: alice.userId, entryId: keepEntry })
    await createCard(app, { userId: alice.userId, entryId: keepEntry, direction: 'production' })
    await reviewCard(app, card.id)
    await createAttempt(app, { userId: alice.userId, entryId: keepEntry })

    const snapshot = async () => ({
      keepCollection: await rowText(migrator, 'collections', keep),
      keepCards: await rowText(migrator, 'srs_cards', keepEntry),
      keepLogs: await rowText(migrator, 'srs_review_logs', keepEntry),
      bobCards: await rowText(migrator, 'srs_cards', bob.entryId),
      bobLogs: await rowText(migrator, 'srs_review_logs', bob.entryId),
    })
    const before = await snapshot()
    expect(before.keepCards).toHaveLength(2)
    expect(before.keepLogs).toHaveLength(1)

    // Wrong title → mismatch, nothing deleted.
    expect(await deleteCollection(db, alice.userId, alice.collectionId, 'animals')).toMatchObject({
      ok: false,
      kind: 'mismatch',
    })
    expect(await getCollection(db, alice.userId, alice.collectionId)).not.toBeNull()

    const result = await deleteCollection(db, alice.userId, alice.collectionId, 'Animals')
    expect(result).toEqual({ ok: true, row: { id: alice.collectionId, ownerId: alice.userId } })

    const [gone] = await migrator<{ n: number }[]>`
      select (select count(*) from collections where id = ${alice.collectionId})
           + (select count(*) from vocabulary_entries where id = ${alice.entryId})
           + (select count(*) from srs_cards where entry_id = ${alice.entryId})
           + (select count(*) from srs_review_logs where card_id = ${alice.cards.recognition.id})
           + (select count(*) from practice_attempts where entry_id = ${alice.entryId}) as n`
    expect(Number(gone!.n)).toBe(0)
    const [keptAttempts] = await migrator<{ n: number }[]>`
      select count(*)::int as n from practice_attempts where entry_id = ${keepEntry}`
    expect(keptAttempts!.n).toBe(1)

    expect(await snapshot()).toEqual(before)
    // Deleting again → not_found.
    expect(await deleteCollection(db, alice.userId, alice.collectionId, 'Animals')).toEqual({
      ok: false,
      kind: 'not_found',
    })
  })

  it('an archived collection can be deleted', async () => {
    const alice = await createUser(app)
    const id = await seedCollection(app, alice, { title: 'Old' })
    await setArchived(db, alice, id, true)
    expect(await deleteCollection(db, alice, id, 'Old')).toMatchObject({ ok: true })
  })
})

describe('archive (I6, D2)', () => {
  it('archiving twice keeps the first archived_at; edits are refused until unarchived', async () => {
    const alice = await createUser(app)
    const created = await createCollection(db, alice, input)
    if (!created.ok) throw new Error('create failed')
    const id = created.row.id
    const entryId = await createEntry(app, id)
    await createCard(app, { userId: alice, entryId })
    const cardsBefore = await rowText(migrator, 'srs_cards', entryId)

    const first = await setArchived(db, alice, id, true)
    expect(first?.archivedAt).toBeInstanceOf(Date)
    const [stamp1] = await migrator<
      { t: string }[]
    >`select archived_at::text as t from collections where id = ${id}`
    await new Promise((r) => setTimeout(r, 5))
    await setArchived(db, alice, id, true)
    const [stamp2] = await migrator<
      { t: string }[]
    >`select archived_at::text as t from collections where id = ${id}`
    expect(stamp2!.t).toBe(stamp1!.t)

    expect(await updateCollection(db, alice, id, { title: 'Nope' })).toEqual({ ok: false, kind: 'archived' })
    // Archiving never touches FSRS state.
    expect(await rowText(migrator, 'srs_cards', entryId)).toEqual(cardsBefore)

    const unarchived = await setArchived(db, alice, id, false)
    expect(unarchived?.archivedAt).toBeNull()
    expect(await setArchived(db, alice, id, false)).toMatchObject({ archivedAt: null })
    expect(await updateCollection(db, alice, id, { title: 'Yes' })).toMatchObject({
      ok: true,
      row: { title: 'Yes' },
    })
    expect(await rowText(migrator, 'srs_cards', entryId)).toEqual(cardsBefore)
  })
})
