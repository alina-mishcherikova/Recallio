// A3, A4, A5 (ADR 0002 §5.4, §8.3): no account enumeration on login; brute-force limits and backoff.
import { describe, expect, it } from 'vitest'
import {
  Client,
  checkNoLeaksAfterAll,
  nextIp,
  registerAccount,
  remember,
  uniqueEmail,
  uniquePassword,
} from './helpers/client'

checkNoLeaksAfterAll()

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Header names that legitimately differ per response. */
const VOLATILE = new Set(['x-request-id', 'date', 'content-security-policy', 'x-ratelimit-remaining'])
const headerShape = (h: Headers) =>
  [...h.keys()]
    .filter((k) => !VOLATILE.has(k))
    .sort()
    .map((k) => `${k}: ${k === 'content-length' ? h.get(k) : '*'}`)

describe('login enumeration (A3)', () => {
  it('unknown email vs wrong password: identical status, body and headers; similar timing', async () => {
    const RUNS = 20
    // Each attempt uses a fresh IP and a fresh account, so no limiter is involved.
    const accounts = []
    for (let i = 0; i < RUNS; i++) accounts.push(await registerAccount(new Client()))

    const warm = new Client()
    for (let i = 0; i < 3; i++)
      await warm.post('/api/auth/login', { email: uniqueEmail(), password: 'warm-up-password' })

    const unknown: number[] = []
    const wrong: number[] = []
    let unknownRes, wrongRes
    for (let i = 0; i < RUNS; i++) {
      // Interleave the two kinds so drift affects both equally.
      const t0 = performance.now()
      unknownRes = await new Client().post('/api/auth/login', {
        email: uniqueEmail('nobody'),
        password: uniquePassword(),
      })
      unknown.push(performance.now() - t0)
      const t1 = performance.now()
      wrongRes = await new Client().post('/api/auth/login', {
        email: accounts[i]!.email,
        password: uniquePassword(),
      })
      wrong.push(performance.now() - t1)
    }

    expect(unknownRes!.status).toBe(401)
    expect(wrongRes!.status).toBe(401)
    expect(unknownRes!.text).toBe(wrongRes!.text)
    expect(unknownRes!.body).toEqual({ statusCode: 401, message: 'Email or password is incorrect.' })
    expect(headerShape(unknownRes!.headers)).toEqual(headerShape(wrongRes!.headers))
    expect(unknownRes!.setCookies).toEqual([])
    expect(wrongRes!.setCookies).toEqual([])

    // Both paths run exactly one scrypt (dummy hash for unknown emails): medians stay close.
    const mu = median(unknown)
    const mw = median(wrong)
    const tolerance = Math.max(25, 0.25 * Math.max(mu, mw))
    expect(Math.abs(mu - mw), `unknown ${mu.toFixed(1)} ms vs wrong ${mw.toFixed(1)} ms`).toBeLessThan(
      tolerance,
    )
    expect(Math.min(mu, mw)).toBeGreaterThan(20) // a scrypt really ran on both paths
  })
})

describe('brute force (A4)', () => {
  it('20 failures from one IP → 429 with Retry-After, before any password check', async () => {
    const attacker = new Client()
    for (let i = 0; i < 20; i++) {
      const res = await attacker.post('/api/auth/login', {
        email: uniqueEmail('spray'),
        password: uniquePassword(),
      })
      expect(res.status, `attempt ${i + 1}`).toBe(401)
    }
    const blocked = await attacker.post('/api/auth/login', {
      email: uniqueEmail('spray'),
      password: uniquePassword(),
    })
    expect(blocked.status).toBe(429)
    const retryAfter = Number(blocked.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(800)
    expect(retryAfter).toBeLessThanOrEqual(900)
    expect(blocked.body).toEqual({ statusCode: 429, message: 'Too many attempts. Try again in 15 minutes.' })

    // Even the right password is refused while blocked (the check comes before the lookup).
    const victim = new Client()
    const account = await registerAccount(victim)
    const correct = await attacker.post('/api/auth/login', {
      email: account.email,
      password: account.password,
    })
    expect(correct.status).toBe(429)
    expect(correct.setCookies).toEqual([])
  })

  it('account backoff across rotating IPs: the 6th attempt → 429 with Retry-After', async () => {
    const account = await registerAccount(new Client())
    for (let i = 0; i < 5; i++) {
      const res = await new Client().post('/api/auth/login', {
        email: account.email,
        password: uniquePassword(),
      })
      expect(res.status, `attempt ${i + 1}`).toBe(401)
    }
    const sixth = await new Client().post('/api/auth/login', {
      email: account.email,
      password: account.password,
    })
    expect(sixth.status).toBe(429)
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThanOrEqual(14)
    expect(Number(sixth.headers.get('retry-after'))).toBeLessThanOrEqual(15)
    expect(sixth.body).toEqual({ statusCode: 429, message: 'Too many attempts. Try again in 1 minute.' })
  })

  it('registration: 10 attempts per IP per hour', async () => {
    const ip = nextIp()
    for (let i = 0; i < 10; i++) {
      const res = await new Client(ip).post('/api/auth/register', {
        email: uniqueEmail('reg'),
        password: uniquePassword(),
        nativeLanguage: 'en',
      })
      expect(res.status, `attempt ${i + 1}`).toBe(201)
    }
    const eleventh = await new Client(ip).post('/api/auth/register', {
      email: uniqueEmail('reg'),
      password: uniquePassword(),
      nativeLanguage: 'en',
    })
    expect(eleventh.status).toBe(429)
    expect(Number(eleventh.headers.get('retry-after'))).toBeGreaterThan(3500)
  })

  it('account deletion re-authentication: 5 wrong passwords, then 429', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    for (let i = 0; i < 5; i++) {
      const res = await client.delete('/api/account', { password: uniquePassword() })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ statusCode: 403, message: 'Password is incorrect.' })
    }
    const blocked = await client.delete('/api/account', { password: account.password })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    expect((await client.get('/api/auth/me')).status).toBe(200) // still signed in, account intact
  })
})

describe('backoff does not reveal existence (A5)', () => {
  it('the same sequence on a registered and an unregistered email gives the same statuses', async () => {
    const registered = await registerAccount(new Client())
    const unregistered = uniqueEmail('ghost')
    remember(unregistered)
    const run = async (email: string) => {
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) {
        statuses.push(
          (await new Client().post('/api/auth/login', { email, password: uniquePassword() })).status,
        )
      }
      return statuses
    }
    const a = await run(registered.email)
    const b = await run(unregistered)
    expect(a).toEqual([401, 401, 401, 401, 401, 429, 429])
    expect(b).toEqual(a)
  })
})
