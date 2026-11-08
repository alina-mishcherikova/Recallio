// I1, I4 (ADR 0002 §2.3, §4.2, §8.2): the session store against real Postgres, as the app role.
import { drizzle } from 'drizzle-orm/postgres-js'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  checkSession,
  countActiveSessions,
  createSession,
  revokeAllSessions,
  revokeSession,
  sweepSessions,
} from '../../server/services/auth/session-store'
import { connectAs, count, expectPgError, truncateAll } from './helpers/db'
import { createUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
// Own pool: drizzle() reconfigures the client's type parsers, which the raw factories rely on.
const db = drizzle(connectAs('app'), { schema })

let alice: string
let bob: string

beforeEach(async () => {
  await truncateAll(migrator)
  alice = await createUser(app)
  bob = await createUser(app)
})

/** Moves a session back in time as the owner (the app role can't touch created_at/expires_at). */
async function age(sid: string, o: { created: string; lastSeen: string; expires: string }) {
  await migrator`
    update user_sessions
       set created_at = now() - ${o.created}::interval,
           last_seen_at = now() - ${o.lastSeen}::interval,
           expires_at = now() - ${o.expires}::interval
     where id = ${sid}`
}

describe('session store (I1)', () => {
  it('a new session is valid, 30 days long, and belongs to its user only', async () => {
    const sid = await createSession(db, alice)
    expect(await checkSession(db, { sid, userId: alice })).toEqual({ ok: true })
    expect(await checkSession(db, { sid, userId: bob })).toEqual({ ok: false, reason: 'revoked' })
    const [row] = await app<{ days: number }[]>`
      select extract(epoch from expires_at - created_at) / 86400 as days from user_sessions where id = ${sid}`
    expect(Number(row!.days)).toBe(30)
  })

  it('past the absolute timeout → expired, and the row is deleted', async () => {
    const sid = await createSession(db, alice)
    await age(sid, { created: '30 days 1 hour', lastSeen: '1 minute', expires: '1 hour' })
    expect(await checkSession(db, { sid, userId: alice })).toEqual({ ok: false, reason: 'expired' })
    expect(await count(migrator, 'user_sessions')).toBe(0)
  })

  it('idle for 8 days → idle, and the row is deleted', async () => {
    const sid = await createSession(db, alice)
    await age(sid, { created: '9 days', lastSeen: '8 days', expires: '-21 days' })
    expect(await checkSession(db, { sid, userId: alice })).toEqual({ ok: false, reason: 'idle' })
    expect(await count(migrator, 'user_sessions')).toBe(0)
  })

  it('touches last_seen_at only when it is more than 1 hour old', async () => {
    const sid = await createSession(db, alice)
    await age(sid, { created: '2 days', lastSeen: '59 minutes', expires: '-28 days' })
    const seen = async () =>
      (await migrator<{ t: Date }[]>`select last_seen_at as t from user_sessions where id = ${sid}`)[0]!.t
    const before = await seen()
    await checkSession(db, { sid, userId: alice })
    expect(await seen()).toEqual(before)

    await age(sid, { created: '2 days', lastSeen: '61 minutes', expires: '-28 days' })
    const stale = await seen()
    await checkSession(db, { sid, userId: alice })
    expect((await seen()).getTime()).toBeGreaterThan(stale.getTime() + 60 * 60 * 1000)
  })

  it('a deleted user’s session is reported as user_missing (the cascade removed the row)', async () => {
    const sid = await createSession(db, alice)
    await app`delete from users where id = ${alice}`
    expect(await checkSession(db, { sid, userId: alice })).toEqual({ ok: false, reason: 'user_missing' })
  })

  it('malformed ids never reach the database', async () => {
    expect(await checkSession(db, { sid: "x' or 1=1 --", userId: alice })).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(await checkSession(db, { sid: crypto.randomUUID(), userId: 'nope' })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('revokes one session, scoped to its user, or all of them', async () => {
    const a1 = await createSession(db, alice)
    const a2 = await createSession(db, alice)
    const b1 = await createSession(db, bob)
    await revokeSession(db, bob, a1) // someone else's sid: no effect
    expect(await checkSession(db, { sid: a1, userId: alice })).toEqual({ ok: true })
    await revokeSession(db, alice, a1)
    expect((await checkSession(db, { sid: a1, userId: alice })).ok).toBe(false)
    expect(await checkSession(db, { sid: a2, userId: alice })).toEqual({ ok: true })
    expect(await revokeAllSessions(db, alice)).toBe(1)
    expect((await checkSession(db, { sid: a2, userId: alice })).ok).toBe(false)
    expect(await checkSession(db, { sid: b1, userId: bob })).toEqual({ ok: true })
  })

  it('rotation deletes the presented session, even if it belongs to another user', async () => {
    const attacker = await createSession(db, bob)
    const sid = await createSession(db, alice, { replaceSessionId: attacker })
    expect((await checkSession(db, { sid: attacker, userId: bob })).ok).toBe(false)
    expect(await checkSession(db, { sid, userId: alice })).toEqual({ ok: true })
  })

  it('keeps at most 10 active sessions per user, deleting the oldest', async () => {
    const sids: string[] = []
    for (let i = 0; i < 12; i++) {
      sids.push(await createSession(db, alice))
      await new Promise((r) => setTimeout(r, 2)) // distinct created_at
    }
    expect(await countActiveSessions(db, alice)).toBe(10)
    expect((await checkSession(db, { sid: sids[0]!, userId: alice })).ok).toBe(false)
    expect((await checkSession(db, { sid: sids[1]!, userId: alice })).ok).toBe(false)
    expect(await checkSession(db, { sid: sids[11]!, userId: alice })).toEqual({ ok: true })
  })

  it('login cleanup removes the user’s expired and idle rows; the sweep removes everyone’s', async () => {
    const old = await createSession(db, alice)
    await age(old, { created: '9 days', lastSeen: '8 days', expires: '-21 days' })
    const bobOld = await createSession(db, bob)
    await age(bobOld, { created: '31 days', lastSeen: '1 day', expires: '1 day' })
    await createSession(db, alice)
    expect(await count(migrator, 'user_sessions')).toBe(2) // alice's new one + bob's expired one
    expect(await sweepSessions(db)).toBe(1)
    expect(await count(migrator, 'user_sessions')).toBe(1)
  })
})

describe('user_sessions privileges and checks (I4)', () => {
  it('the app role cannot move a session or extend its lifetime', async () => {
    const sid = await createSession(db, alice)
    await expectPgError(app`update user_sessions set user_id = ${bob} where id = ${sid}`, { code: '42501' })
    await expectPgError(
      app`update user_sessions set expires_at = now() + interval '1 year' where id = ${sid}`,
      {
        code: '42501',
      },
    )
    await expectPgError(app`update user_sessions set created_at = now() where id = ${sid}`, { code: '42501' })
    await app`update user_sessions set last_seen_at = now() where id = ${sid}`
  })

  it('rejects a lifetime over 30 days, and last_seen_at before created_at', async () => {
    await expectPgError(
      app`insert into user_sessions (user_id, expires_at) values (${alice}, now() + interval '31 days')`,
      { code: '23514', constraint: 'user_sessions_expiry' },
    )
    await expectPgError(app`insert into user_sessions (user_id, expires_at) values (${alice}, now())`, {
      code: '23514',
      constraint: 'user_sessions_expiry',
    })
    await expectPgError(
      app`insert into user_sessions (user_id, last_seen_at, expires_at)
          values (${alice}, now() - interval '1 day', now() + interval '1 day')`,
      { code: '23514', constraint: 'user_sessions_seen' },
    )
  })
})
