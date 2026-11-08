// A2, A8, A11, A15, A17 (ADR 0002 §6, §8.3): deny by default, deleted users, IDOR, error bodies.
import { describe, expect, it } from 'vitest'
import { apiErrorSchema } from '../../shared/schemas/auth'
import { isPublicApiRoute } from '../../server/utils/public-routes'
import { connectAs } from '../integration/helpers/db'
import { concretePath, listApiRoutes } from '../helpers/api-routes'
import { Client, checkNoLeaksAfterAll, registerAccount } from './helpers/client'
import { expectIdor } from './helpers/idor'

checkNoLeaksAfterAll()
const migrator = connectAs('migrator')

const protectedRoutes = listApiRoutes()
  .filter((r) => r.method === 'ALL' || !isPublicApiRoute(r.method, r.path))
  .flatMap((r) =>
    r.method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ ...r, method: m })) : [r],
  )

describe('every protected route without a session → 401 (A2)', () => {
  it('covers the routes on disk', () => {
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(4)
  })

  it.each(protectedRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('%s', async (_label, route) => {
    const client = new Client()
    const res = await client.send(
      route.method,
      concretePath(route.path),
      route.method === 'GET' ? {} : { json: {} },
    )
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ statusCode: 401, message: 'Unauthorized' })
    expect(res.setCookies).toEqual([]) // no anonymous cookie
  })

  it.each([
    '/api/nope',
    '/api/auth',
    '/api/health/',
    '/api/health/x',
    '/API/health',
    '/api//health',
    '/api/auth/login/',
  ])('unknown or non-exact %s → 401 for anonymous callers', async (path) => {
    const res = await new Client().get(path)
    expect(res.status).toBe(401)
  })

  it('with a session, an unknown API route → JSON 404 (A15)', async () => {
    const client = new Client()
    await registerAccount(client)
    const res = await client.get('/api/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ statusCode: 404, message: 'Not Found' })
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  })

  it('anonymous public routes set no cookie, and /api/_auth/session is {}', async () => {
    const client = new Client()
    for (const path of ['/api/health', '/api/_auth/session']) {
      const res = await client.get(path)
      expect(res.status).toBe(200)
      expect(res.setCookies).toEqual([])
    }
    expect((await client.get('/api/_auth/session')).body).toEqual({})
  })
})

describe("a deleted user's cookie (A8)", () => {
  it('is rejected everywhere and cleared; /api/_auth/session reads {}', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    const cookie = client.cookie!
    await migrator`delete from users where id = ${account.userId}`

    const me = await client.get('/api/auth/me', { cookie: `__Host-recallio-session=${cookie}` })
    expect(me.status).toBe(401)
    expect(me.setCookies.some((c) => /max-age=0/i.test(c))).toBe(true)

    const session = await client.get('/api/_auth/session', { cookie: `__Host-recallio-session=${cookie}` })
    expect(session.status).toBe(200)
    expect(session.body).toEqual({})

    const del = await client.delete(
      '/api/account',
      { password: account.password },
      {
        cookie: `__Host-recallio-session=${cookie}`,
      },
    )
    expect(del.status).toBe(401)
  })
})

describe('IDOR (A11)', () => {
  it("a body can't name another user: DELETE /api/account with { userId: B } → 400, B still exists", async () => {
    const a = new Client()
    const accountA = await registerAccount(a)
    const b = new Client()
    const accountB = await registerAccount(b)

    const res = await a.delete('/api/account', { password: accountA.password, userId: accountB.userId })
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(res.body).issues).toEqual([{ path: '', message: 'Unknown field.' }])
    expect(JSON.stringify(res.body)).not.toContain(accountB.userId)

    // B's password with A's session never deletes B (identity comes only from the session).
    expect((await a.delete('/api/account', { password: accountB.password })).status).toBe(403)
    const rows = await migrator<
      { id: string }[]
    >`select id from users where id in ${migrator([accountA.userId, accountB.userId])}`
    expect(rows).toHaveLength(2)
    expect((await b.get('/api/auth/me')).status).toBe(200)
  })

  it('expectIdor helper works against a session-scoped route (fixture until LEX-004)', async () => {
    // /api/auth/me returns the caller's own profile: user B can never read A's data through it.
    await expectIdor({
      setupA: async (client) => (await registerAccount(client)).userId,
      setupB: async (client) => {
        await registerAccount(client)
      },
      request: (client) => client.get('/api/auth/me'),
      status: 200, // session-scoped, not an owned resource: B gets B's own profile
      leaks: (body, aId) => JSON.stringify(body).includes(aId),
    })
  })
})

describe('error bodies (A15) and icons (A17)', () => {
  it('error bodies are exactly { statusCode, message } with no URL or host; Cache-Control: no-store', async () => {
    const client = new Client()
    const res = await client.get('/api/nope?debug=<b>1</b>')
    expect(res.status).toBe(401)
    expect(Object.keys(res.body as object).sort()).toEqual(['message', 'statusCode'])
    expect(res.text).not.toMatch(/127\.0\.0\.1|localhost|\/api\/nope|stack|node_modules|\.output/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const ok = await client.get('/api/health')
    expect(ok.headers.get('cache-control')).toBe('no-store')
  })

  it('HEAD /api/health behaves like GET: public, same status, no body', async () => {
    const client = new Client()
    const get = await client.get('/api/health')
    const head = await client.send('HEAD', '/api/health')
    expect(head.status).toBe(get.status)
    expect([200, 503]).toContain(head.status)
    expect(head.text).toBe('')
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(head.setCookies).toEqual([])
  })

  it('icons load from /_nuxt_icon without a session', async () => {
    const res = await new Client().get('/_nuxt_icon/lucide.json?icons=check')
    expect(res.status).toBe(200)
    expect(res.setCookies).toEqual([])
  })
})
