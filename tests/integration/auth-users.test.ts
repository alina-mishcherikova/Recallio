// I2, I3, I5 (ADR 0002 §5.5, §8.2): user persistence for auth, account deletion, SRS isolation.
import { drizzle } from 'drizzle-orm/postgres-js'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { checkSession, createSession, revokeSession } from '../../server/services/auth/session-store'
import {
  createUser,
  deleteUser,
  findCredentialsByEmail,
  findPublicUserById,
} from '../../server/services/auth/users'
import { publicUserSchema } from '../../shared/schemas/auth'
import { connectAs, count, publicTables, truncateAll } from './helpers/db'
import { seedUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
// Own pool: drizzle() reconfigures the client's type parsers, which the raw factories rely on.
const db = drizzle(connectAs('app'), { schema })

beforeEach(() => truncateAll(migrator))

const hash = '$scrypt$n=16384,r=8,p=5$c2FsdA$aGFzaA'

describe('createUser (I2)', () => {
  it('maps a case-insensitive duplicate to a result, not a thrown 23505', async () => {
    const first = await createUser(db, { email: 'A@x.fr', passwordHash: hash, nativeLanguage: 'fr' })
    expect(first.ok).toBe(true)
    const second = await createUser(db, { email: 'a@x.fr', passwordHash: 'other', nativeLanguage: 'en' })
    expect(second).toEqual({ ok: false, reason: 'duplicate_email' })
    // The existing account is untouched.
    const row = await findCredentialsByEmail(db, 'a@X.FR')
    expect(row?.passwordHash).toBe(hash)
  })

  it('returns only the public DTO', async () => {
    const created = await createUser(db, {
      email: 'b@x.fr',
      passwordHash: hash,
      nativeLanguage: 'en',
      timezone: 'Europe/Paris',
    })
    if (!created.ok) throw new Error('expected success')
    expect(publicUserSchema.parse(created.user)).toEqual(created.user)
    expect(created.user.timezone).toBe('Europe/Paris')
    expect(await findPublicUserById(db, created.user.id)).toEqual(created.user)
    expect(JSON.stringify(created.user)).not.toContain('scrypt')
  })

  it('defaults the timezone to UTC', async () => {
    const created = await createUser(db, { email: 'c@x.fr', passwordHash: hash, nativeLanguage: 'en' })
    expect(created.ok && created.user.timezone).toBe('UTC')
  })
})

describe('deleteUser as the app role (I3, spec §15)', () => {
  it("removes the user's sessions and every other row; a second user is untouched", async () => {
    const alice = await seedUser(app)
    const bob = await seedUser(app)
    const aliceSid = await createSession(db, alice.userId)
    const bobSid = await createSession(db, bob.userId)
    const tables = await publicTables(migrator)
    const before: Record<string, number> = {}
    for (const t of tables) before[t] = await count(migrator, t)

    expect(await deleteUser(db, alice.userId)).toBe(true)
    expect(await deleteUser(db, alice.userId)).toBe(false)

    for (const t of tables) expect(await count(migrator, t), t).toBe(before[t]! / 2)
    expect((await checkSession(db, { sid: aliceSid, userId: alice.userId })).ok).toBe(false)
    expect(await checkSession(db, { sid: bobSid, userId: bob.userId })).toEqual({ ok: true })
  })
})

describe('auth leaves SRS untouched (I5, rule 1)', () => {
  it('create → session → revoke → delete another user keeps srs_* identical', async () => {
    const bob = await seedUser(app)
    const snapshot = () =>
      migrator`select (select md5(coalesce(string_agg(c::text, ',' order by c.id), '')) from srs_cards c) as cards,
                      (select md5(coalesce(string_agg(l::text, ',' order by l.id), '')) from srs_review_logs l) as logs`
    const before = await snapshot()
    const created = await createUser(db, { email: 'd@x.fr', passwordHash: hash, nativeLanguage: 'fr' })
    if (!created.ok) throw new Error('expected success')
    const sid = await createSession(db, created.user.id)
    await checkSession(db, { sid, userId: created.user.id })
    await revokeSession(db, created.user.id, sid)
    await deleteUser(db, created.user.id)
    expect(await snapshot()).toEqual(before)
    expect(await count(migrator, 'srs_cards')).toBe(2)
    expect(bob.cards.recognition.user_id).toBe(bob.userId)
  })
})
