// A6, A7, A9 (ADR 0002 §4, §8.3): fixation, logout revocation with replayed cookies, timeouts.
import { describe, expect, it } from 'vitest'
import { connectAs } from '../integration/helpers/db'
import { Client, SESSION_COOKIE, checkNoLeaksAfterAll, registerAccount } from './helpers/client'

checkNoLeaksAfterAll()
const migrator = connectAs('migrator')
const asCookie = (value: string) => `${SESSION_COOKIE}=${value}`

describe('session fixation (A6)', () => {
  it("an attacker's own valid cookie is never upgraded: login rotates it and its row is deleted", async () => {
    const victim = await registerAccount(new Client())
    const attacker = new Client()
    await registerAccount(attacker)
    const planted = attacker.cookie!

    // The victim logs in in a browser that carries the attacker's cookie.
    const browser = new Client()
    browser.cookie = planted
    const login = await browser.post('/api/auth/login', { email: victim.email, password: victim.password })
    expect(login.status).toBe(200)
    expect(login.setCookies.filter((c) => c.startsWith(`${SESSION_COOKIE}=`))).toHaveLength(1)
    expect(browser.cookie).toBeDefined()
    expect(browser.cookie).not.toBe(planted)
    expect(((await browser.get('/api/auth/me')).body as { user: { id: string } }).user.id).toBe(victim.userId)

    // The planted cookie is dead: its session row was deleted at login.
    const old = await new Client().get('/api/auth/me', { cookie: asCookie(planted) })
    expect(old.status).toBe(401)
  })

  it('every login issues a new cookie, even for the same user', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    const first = client.cookie
    await client.post('/api/auth/login', { email: account.email, password: account.password })
    expect(client.cookie).not.toBe(first)
    expect((await new Client().get('/api/auth/me', { cookie: asCookie(first!) })).status).toBe(401)
  })

  it.each([
    ['garbage', 'not-a-sealed-value'],
    ['a truncated seal', 'Fe26.2**abc*def'],
    ['an empty value', ''],
  ])('a forged cookie (%s) is anonymous and cleared', async (_label, value) => {
    const res = await new Client().get('/api/auth/me', { cookie: asCookie(value) })
    expect(res.status).toBe(401)
    const health = await new Client().get('/api/health', { cookie: asCookie(value) })
    expect(health.status).toBe(200)
    if (value)
      expect(health.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /max-age=0/i.test(c))).toBe(
        true,
      )
  })
})

describe('logout revocation (A7)', () => {
  it('a copy of the cookie replayed after logout → 401 and a clearing Set-Cookie', async () => {
    const client = new Client()
    await registerAccount(client)
    const copy = client.cookie!
    expect((await client.post('/api/auth/logout')).status).toBe(204) // empty body allowed
    const replay = await new Client().get('/api/auth/me', { cookie: asCookie(copy) })
    expect(replay.status).toBe(401)
    expect(replay.setCookies.some((c) => /max-age=0/i.test(c))).toBe(true)
    expect((await new Client().post('/api/auth/logout', {}, { cookie: asCookie(copy) })).status).toBe(401)
  })

  it("scope: 'current' keeps other devices; scope: 'all' signs out every device", async () => {
    const laptop = new Client()
    const account = await registerAccount(laptop)
    const phone = new Client()
    const tablet = new Client()
    for (const device of [phone, tablet]) {
      expect(
        (await device.post('/api/auth/login', { email: account.email, password: account.password })).status,
      ).toBe(200)
    }
    expect((await tablet.post('/api/auth/logout', { scope: 'current' })).status).toBe(204)
    expect((await laptop.get('/api/auth/me')).status).toBe(200)
    expect((await phone.get('/api/auth/me')).status).toBe(200)

    const phoneCookie = phone.cookie!
    expect((await laptop.post('/api/auth/logout', { scope: 'all' })).status).toBe(204)
    expect((await new Client().get('/api/auth/me', { cookie: asCookie(phoneCookie) })).status).toBe(401)
  })

  it('rejects an unknown logout scope (strict)', async () => {
    const client = new Client()
    await registerAccount(client)
    expect((await client.post('/api/auth/logout', { scope: 'everyone' })).status).toBe(400)
    expect((await client.get('/api/auth/me')).status).toBe(200)
  })
})

describe('timeouts (A9, database clock)', () => {
  it('idle for 8 days → 401', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    await migrator`
      update user_sessions
         set created_at = now() - interval '9 days', last_seen_at = now() - interval '8 days',
             expires_at = now() - interval '9 days' + interval '30 days'
       where user_id = ${account.userId}`
    const res = await client.get('/api/auth/me')
    expect(res.status).toBe(401)
    const [row] = await migrator<
      { n: number }[]
    >`select count(*)::int as n from user_sessions where user_id = ${account.userId}`
    expect(row!.n).toBe(0)
  })

  it('past the absolute 30 days (but recently active) → 401', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    await migrator`
      update user_sessions
         set created_at = now() - interval '30 days 1 hour', last_seen_at = now() - interval '1 minute',
             expires_at = now() - interval '1 hour'
       where user_id = ${account.userId}`
    expect((await client.get('/api/auth/me')).status).toBe(401)
  })

  it('reading a session never extends the cookie (no Set-Cookie on authenticated reads)', async () => {
    const client = new Client()
    await registerAccount(client)
    for (const path of ['/api/auth/me', '/api/_auth/session', '/api/health']) {
      expect((await client.get(path)).setCookies).toEqual([])
    }
  })
})
