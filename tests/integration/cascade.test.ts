// Cascades (ADR 0001 §2.3, §6.6). Deletes run as the app role, which has no DELETE on the SRS
// tables: FK cascade actions run as the table owner, so they still reach cards and logs.
import { describe, expect, it, beforeEach } from 'vitest'
import { connectAs, count, publicTables, truncateAll } from './helpers/db'
import { createAnswer, getCard, seedUser, type SeededUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

async function countsByTable(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of await publicTables(migrator)) counts[table] = await count(migrator, table)
  return counts
}

let alice: SeededUser
let bob: SeededUser

beforeEach(async () => {
  await truncateAll(migrator)
  alice = await seedUser(app)
  bob = await seedUser(app)
})

describe('account deletion (X1, GDPR)', () => {
  it("deleting a user removes every one of their rows and leaves other users' data intact", async () => {
    const before = await countsByTable()
    // The seed must cover every table, or this test proves nothing for the missing ones.
    for (const [table, n] of Object.entries(before)) {
      expect(n, `${table} is not seeded by seedUser()`).toBeGreaterThanOrEqual(2)
      expect(n % 2, `${table} should hold the same rows for both users`).toBe(0)
    }

    await app`delete from users where id = ${alice.userId}`

    const after = await countsByTable()
    for (const [table, n] of Object.entries(before)) {
      expect(after[table], table).toBe(n / 2)
    }
    const [leftovers] = await migrator<{ n: number }[]>`
      select (select count(*) from collections where owner_id = ${alice.userId})
           + (select count(*) from srs_cards where user_id = ${alice.userId})
           + (select count(*) from practice_attempts where user_id = ${alice.userId})
           + (select count(*) from answer_flags where user_id = ${alice.userId})
           + (select count(*) from answer_change_log where user_id = ${alice.userId})
           + (select count(*) from srs_review_logs l join srs_cards c on c.id = l.card_id
               where c.user_id = ${alice.userId}) as n`
    expect(Number(leftovers!.n)).toBe(0)
    expect(await getCard(app, bob.cards.recognition.id)).toEqual(bob.cards.recognition)
    expect(await count(migrator, 'srs_guard.review_grants')).toBe(0)
  })
})

describe('content deletion', () => {
  it('deleting a collection removes everything below it (X2)', async () => {
    const before = await countsByTable()
    await app`delete from collections where id = ${alice.collectionId}`
    const after = await countsByTable()
    // Only bob's rows remain below collections; both users (and their sessions) remain.
    const userLevel = new Set(['users', 'user_sessions'])
    for (const [table, n] of Object.entries(before)) {
      expect(after[table], table).toBe(userLevel.has(table) ? n : n / 2)
    }
  })

  it('deleting an entry removes its cards and logs, although the app role cannot DELETE them (X3)', async () => {
    await app`delete from vocabulary_entries where id = ${alice.entryId}`
    const [row] = await app<{ cards: number; logs: number }[]>`
      select (select count(*)::int from srs_cards where entry_id = ${alice.entryId}) as cards,
             (select count(*)::int from srs_review_logs where card_id = ${alice.cards.recognition.id}) as logs`
    expect(row).toEqual({ cards: 0, logs: 0 })
    expect(await count(app, 'srs_cards')).toBe(2) // bob's
  })

  it('deleting an accepted answer keeps the attempt (matched_answer_id = null) and the change log (X4)', async () => {
    await app`delete from accepted_answers where id = ${alice.answerId}`
    const attempts = await app`
      select matched_answer_id, is_correct from practice_attempts where user_id = ${alice.userId}`
    expect(attempts).toEqual([{ matched_answer_id: null, is_correct: true }])
    const [log] = await app<{ n: number }[]>`
      select count(*)::int as n from answer_change_log where answer_id = ${alice.answerId}`
    expect(log!.n).toBe(1)
  })

  it('deleting a meaning removes its answers and keeps the entry (X5)', async () => {
    const unlinked = await createAnswer(app, { entryId: alice.entryId, language: 'en' })
    await app`delete from vocabulary_meanings where id = ${alice.meaningId}`
    const answers = await app`select id from accepted_answers where entry_id = ${alice.entryId}`
    expect(answers).toEqual([{ id: unlinked }])
    const [entry] = await app<{ n: number }[]>`
      select count(*)::int as n from vocabulary_entries where id = ${alice.entryId}`
    expect(entry!.n).toBe(1)
  })
})

describe('editing content does not touch scheduling (X6, US-VOC-02)', () => {
  it('updating an entry and bumping its revision leaves both cards identical', async () => {
    const before = await app`select * from srs_cards where entry_id = ${alice.entryId} order by id`
    await app`
      update vocabulary_entries
         set target_expression = 'le chaton', native_expression = 'the kitten',
             revision = revision + 1, updated_at = now()
       where id = ${alice.entryId}`
    const after = await app`select * from srs_cards where entry_id = ${alice.entryId} order by id`
    expect(after).toEqual(before)
  })
})
