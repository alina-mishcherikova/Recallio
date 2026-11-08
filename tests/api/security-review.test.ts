// Abuse cases from the LEX-003 security review (ADR 0002 §5.4, §6.2, §6.7). Each one reproduces a
// finding seen against a built server; they fail until the matching fix lands.
//   S1  DELETE /api/_auth/session is blocked only for the exact path: a trailing slash (or another
//       router-equivalent spelling) reaches the module route, which clears the cookie but leaves the
//       user_sessions row valid and writes no audit line.
//   S2  Per-IP limits key on the full IPv6 address. One client with a /64 can rotate addresses and
//       never hit the IP window (login 20 / 15 min, register 10 / h).
//   S3  /__nuxt_error reflects the request URL, including a client-chosen Host, in its JSON body.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Client,
  ORIGIN,
  checkNoLeaksAfterAll,
  registerAccount,
  uniqueEmail,
  uniquePassword,
} from './helpers/client'

checkNoLeaksAfterAll()

/** A fresh documentation /64 for each call, so these tests never share a bucket with other files. */
function fresh64(): string {
  const h = randomBytes(4).toString('hex')
  return `2001:db8:${h.slice(0, 4)}:${h.slice(4)}`
}

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length

describe('S1: the module logout route is unreachable under every router-equivalent path', () => {
  it.each(['/api/_auth/session/', '/api/_auth/session//', '/api/_auth/session/?x=1'])(
    'DELETE %s → 404, no cookie change, the session stays usable',
    async (path) => {
      const client = new Client(`${fresh64()}::1`)
      await registerAccount(client)
      const before = client.cookie
      const res = await client.delete(path)
      expect(res.status, res.text).toBe(404)
      expect(res.setCookies).toEqual([])
      expect(client.cookie).toBe(before)
      expect((await client.get('/api/auth/me')).status).toBe(200)
    },
  )

  it('a cookie can never be cleared without its server-side row being revoked', async () => {
    const client = new Client(`${fresh64()}::1`)
    await registerAccount(client)
    const copy = client.cookie!
    const res = await client.delete('/api/_auth/session/')
    // Whatever the module route does, a replayed copy must not outlive a "logout": if this response
    // cleared the cookie, the row must be revoked too. (With the fix it is a 404 that clears nothing,
    // so the session legitimately stays valid, as the previous test requires.)
    const cleared = res.setCookies.some(
      (c) => c.startsWith('__Host-recallio-session=') && /max-age=0/i.test(c),
    )
    const replay = await new Client(`${fresh64()}::1`).get('/api/auth/me', {
      cookie: `__Host-recallio-session=${copy}`,
    })
    if (cleared && replay.status === 200) {
      throw new Error('cookie cleared through /api/_auth/session/ but the session row is still valid')
    }
    expect(cleared).toBe(false)
  })
})

describe('S2: per-IP limits cover the whole IPv6 /64', () => {
  it('login: 25 sequential failures from one /64 with rotating interface ids → 429 by the 21st', async () => {
    const prefix = fresh64()
    const statuses: number[] = []
    for (let i = 1; i <= 25; i++) {
      const res = await new Client(`${prefix}::${i.toString(16)}`).post('/api/auth/login', {
        email: uniqueEmail('v6'),
        password: uniquePassword(),
      })
      statuses.push(res.status)
    }
    expect(count(statuses, 429), `statuses: ${statuses.join(',')}`).toBeGreaterThanOrEqual(5)
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
  })

  it('register: 12 attempts from one /64 with rotating interface ids → 429 after 10', async () => {
    const prefix = fresh64()
    const statuses: number[] = []
    for (let i = 1; i <= 12; i++) {
      const res = await new Client(`${prefix}::${i.toString(16)}`).post('/api/auth/register', {
        email: uniqueEmail('v6r'),
        password: uniquePassword(),
        nativeLanguage: 'en',
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(10), `statuses: ${statuses.join(',')}`).toEqual([429, 429])
  })
})

describe('S3: error pages never reflect the request URL or Host', () => {
  it('external GET /__nuxt_error with a hostile Host and query → body contains neither', async () => {
    const marker = 'Zq7reflectmarker'
    const res = await fetch(
      `${ORIGIN}/__nuxt_error?statusCode=500&statusMessage=${marker}&message=${marker}`,
      {
        headers: { accept: 'application/json', host: 'evil.example' },
        redirect: 'manual',
      },
    )
    const text = await res.text()
    expect(res.status).toBe(404)
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain(marker)
  })
})
