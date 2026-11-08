// Concurrency and lifecycle cases the sequential A1–A17 tests can't see (ADR 0002 §4.2, §5.4, §5.5).
//   - Rate limits must hold under parallel requests: a limit that is checked before the scrypt and
//     recorded after it lets a burst of N parallel guesses through (NIST 800-63B §5.2.2, OWASP A07).
//   - Concurrent duplicate registrations: exactly one account, the others get the fixed 409.
//   - Idle timeout slides: an active session stays valid and is touched (not only denied when idle).
//   - Account deletion signs out every device (the user_sessions cascade, through HTTP).
import { describe, expect, it } from 'vitest'
import { connectAs } from '../integration/helpers/db'
import {
  Client,
  SESSION_COOKIE,
  checkNoLeaksAfterAll,
  nextIp,
  registerAccount,
  uniqueEmail,
  uniquePassword,
} from './helpers/client'

checkNoLeaksAfterAll()
const migrator = connectAs('migrator')
const asCookie = (value: string) => `${SESSION_COOKIE}=${value}`

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length

describe('rate limits hold under parallel requests (A07)', () => {
  it('account backoff: a burst of 15 parallel wrong passwords from 15 IPs → at most 5 are evaluated', async () => {
    const account = await registerAccount(new Client())
    const statuses = await Promise.all(
      Array.from(
        { length: 15 },
        async () =>
          (await new Client().post('/api/auth/login', { email: account.email, password: uniquePassword() }))
            .status,
      ),
    )
    // 5 free failures (§5.4); every other attempt must be refused before the password check.
    expect(count(statuses, 401), `statuses: ${statuses.join(',')}`).toBeLessThanOrEqual(5)
    expect(count(statuses, 401) + count(statuses, 429)).toBe(15)
  })

  it('IP window: a burst of 30 parallel failed logins from one IP → at most 20 are evaluated', async () => {
    const ip = nextIp()
    const statuses = await Promise.all(
      Array.from(
        { length: 30 },
        async () =>
          (
            await new Client(ip).post('/api/auth/login', {
              email: uniqueEmail('burst'),
              password: uniquePassword(),
            })
          ).status,
      ),
    )
    expect(count(statuses, 401), `statuses: ${statuses.join(',')}`).toBeLessThanOrEqual(20)
    expect(count(statuses, 401) + count(statuses, 429)).toBe(30)
  })

  it('re-authentication: a burst of 10 parallel wrong passwords on DELETE /api/account → at most 5 are evaluated', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    const statuses = await Promise.all(
      Array.from(
        { length: 10 },
        async () => (await client.delete('/api/account', { password: uniquePassword() })).status,
      ),
    )
    expect(count(statuses, 403), `statuses: ${statuses.join(',')}`).toBeLessThanOrEqual(5)
    expect(count(statuses, 403) + count(statuses, 429)).toBe(10)
    const [row] = await migrator<
      { n: number }[]
    >`select count(*)::int as n from users where id = ${account.userId}`
    expect(row!.n).toBe(1)
  })

  it('registration: 15 parallel attempts from one IP → at most 10 are accepted', async () => {
    const ip = nextIp()
    const statuses = await Promise.all(
      Array.from(
        { length: 15 },
        async () =>
          (
            await new Client(ip).post('/api/auth/register', {
              email: uniqueEmail('reg-burst'),
              password: uniquePassword(),
              nativeLanguage: 'en',
            })
          ).status,
      ),
    )
    expect(count(statuses, 201), `statuses: ${statuses.join(',')}`).toBe(10)
    expect(count(statuses, 429)).toBe(5)
  })
})

describe('concurrent duplicate registration (D4)', () => {
  it('5 parallel registrations of one email → exactly one 201 and four fixed 409s, one row', async () => {
    const email = uniqueEmail('race')
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        new Client().post('/api/auth/register', {
          // Case and whitespace variants: citext + normalization make them the same account.
          email: i % 2 ? email.toUpperCase() : ` ${email} `,
          password: uniquePassword(),
          nativeLanguage: 'fr',
        }),
      ),
    )
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409, 409, 409, 409])
    for (const r of results.filter((r) => r.status === 409)) {
      expect(r.body).toEqual({
        statusCode: 409,
        message: 'Could not create an account with this email. If you already have one, log in.',
      })
      expect(r.setCookies).toEqual([])
    }
    const [row] = await migrator<{ n: number }[]>`select count(*)::int as n from users where email = ${email}`
    expect(row!.n).toBe(1)
  })
})

describe('idle timeout slides with activity (§4.2)', () => {
  it('a session last seen 6 days ago is still valid and is touched to now', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    await migrator`
      update user_sessions
         set created_at = now() - interval '20 days', last_seen_at = now() - interval '6 days',
             expires_at = now() - interval '20 days' + interval '30 days'
       where user_id = ${account.userId}`
    const res = await client.get('/api/auth/me')
    expect(res.status).toBe(200)
    expect(res.setCookies).toEqual([]) // the touch is server-side; the cookie TTL never grows
    const [row] = await migrator<{ touched: boolean }[]>`
      select last_seen_at > now() - interval '1 minute' as touched
        from user_sessions where user_id = ${account.userId}`
    expect(row!.touched).toBe(true)
  })
})

describe('account deletion signs out every device (§5.5, I3 through HTTP)', () => {
  it("the other devices' cookies → 401 after DELETE /api/account; no session rows remain", async () => {
    const laptop = new Client()
    const account = await registerAccount(laptop)
    const phone = new Client()
    expect(
      (await phone.post('/api/auth/login', { email: account.email, password: account.password })).status,
    ).toBe(200)
    const phoneCookie = phone.cookie!

    expect((await laptop.delete('/api/account', { password: account.password })).status).toBe(204)

    const replay = await new Client().get('/api/auth/me', { cookie: asCookie(phoneCookie) })
    expect(replay.status).toBe(401)
    expect(replay.setCookies.some((c) => /max-age=0/i.test(c))).toBe(true)
    const [row] = await migrator<
      { n: number }[]
    >`select count(*)::int as n from user_sessions where user_id = ${account.userId}`
    expect(row!.n).toBe(0)
  })
})
