// C1–C9 (ADR 0003 §6.3): the collections API, black-box against the built server.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { apiErrorSchema } from '../../shared/schemas/auth'
import {
  COLLECTION_MESSAGES,
  collectionListSchema,
  collectionSchema,
  type Collection,
} from '../../shared/schemas/collections'
import { LANGUAGE_MESSAGE } from '../../shared/constants/languages'
import { connectAs } from '../integration/helpers/db'
import { createEntry } from '../integration/helpers/factories'
import {
  Client,
  auditLines,
  checkNoLeaksAfterAll,
  readServerLog,
  registerAccount,
  waitForAudit,
  type ApiResponse,
} from './helpers/client'
import { expectIdor } from './helpers/idor'

checkNoLeaksAfterAll()
const migrator = connectAs('migrator')

/** Unique per call, so the log scan can prove titles are never logged. */
const titles: string[] = []
function uniqueTitle(prefix = 'Coll'): string {
  const title = `${prefix} ${randomUUID().slice(0, 13)}`
  titles.push(title)
  return title
}

async function signedIn(): Promise<{ client: Client; userId: string }> {
  const client = new Client()
  const { userId } = await registerAccount(client)
  return { client, userId }
}

async function create(client: Client, body: Record<string, unknown> = {}): Promise<Collection> {
  const res = await client.post('/api/collections', {
    title: uniqueTitle(),
    nativeLanguage: 'en',
    targetLanguage: 'fr',
    ...body,
  })
  expect(res.status, res.text).toBe(201)
  return collectionSchema.parse(res.body)
}

async function storedRow(id: string): Promise<string | undefined> {
  const [row] = await migrator<{ t: string }[]>`select c::text as t from collections c where id = ${id}`
  return row?.t
}

const OWNER_KEYS = /^(ownerId|owner_id|normalization)$/

/** Deep scan for keys that must never leave the server. */
function ownerKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => ownerKeys(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(OWNER_KEYS.test(k) ? [`${path}.${k}`] : []),
      ...ownerKeys(v, `${path}.${k}`),
    ])
  }
  return []
}

const allBodies: unknown[] = []
function track(res: ApiResponse): ApiResponse {
  allBodies.push(res.body)
  return res
}

function expect404(res: ApiResponse) {
  expect(res.status, res.text).toBe(404)
  expect(res.body).toEqual({ statusCode: 404, message: 'Not Found' })
}

describe('CRUD journey (C1)', () => {
  it('create → get → list → rename → archive → filters → unarchive → delete → 404', async () => {
    const { client } = await signedIn()
    const title = uniqueTitle('Journey')
    const created = track(
      await client.post('/api/collections', {
        title: `  ${title}  `,
        nativeLanguage: 'en',
        targetLanguage: 'fr',
        description: 'Farm and zoo',
        topic: '',
      }),
    )
    expect(created.status).toBe(201)
    const c = collectionSchema.parse(created.body)
    expect(c).toMatchObject({
      title,
      nativeLanguage: 'en',
      targetLanguage: 'fr',
      description: 'Farm and zoo',
      topic: null,
      archivedAt: null,
      entryCount: 0,
    })

    const got = track(await client.get(`/api/collections/${c.id}`))
    expect(got.status).toBe(200)
    expect(got.body).toEqual(c)

    const list = track(await client.get('/api/collections'))
    expect(list.status).toBe(200)
    expect(collectionListSchema.parse(list.body).items.map((i) => i.id)).toContain(c.id)

    const renamed = track(await client.patch(`/api/collections/${c.id}`, { title: `${title} 2` }))
    expect(renamed.status, renamed.text).toBe(200)
    expect(collectionSchema.parse(renamed.body).title).toBe(`${title} 2`)
    titles.push(`${title} 2`)

    const archived = track(await client.post(`/api/collections/${c.id}/archive`))
    expect(archived.status, archived.text).toBe(200)
    const archivedAt = collectionSchema.parse(archived.body).archivedAt
    expect(archivedAt).not.toBeNull()
    // Idempotent: the first timestamp stays.
    const again = track(await client.post(`/api/collections/${c.id}/archive`, {}))
    expect(collectionSchema.parse(again.body).archivedAt).toBe(archivedAt)

    const active = collectionListSchema.parse(track(await client.get('/api/collections?status=active')).body)
    expect(active.items.map((i) => i.id)).not.toContain(c.id)
    const archivedList = collectionListSchema.parse(
      track(await client.get('/api/collections?status=archived')).body,
    )
    expect(archivedList.items.map((i) => i.id)).toContain(c.id)

    // D2: read-only while archived.
    const blocked = track(await client.patch(`/api/collections/${c.id}`, { title: 'Nope' }))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual({ statusCode: 409, message: COLLECTION_MESSAGES.archived })

    const unarchived = track(await client.post(`/api/collections/${c.id}/unarchive`))
    expect(unarchived.status).toBe(200)
    expect(collectionSchema.parse(unarchived.body).archivedAt).toBeNull()

    const deleted = await client.delete(`/api/collections/${c.id}`, { confirmTitle: `${title} 2` })
    expect(deleted.status, deleted.text).toBe(204)
    expect(deleted.text).toBe('')
    expect404(await client.get(`/api/collections/${c.id}`))
  })
})

describe('IDOR on every route (C2)', () => {
  type Setup = { id: string; title: string; before?: string }
  const setupA = async (client: Client): Promise<Setup> => {
    await registerAccount(client)
    const c = await create(client)
    return { id: c.id, title: c.title, before: await storedRow(c.id) }
  }
  const setupB = async (client: Client) => {
    await registerAccount(client)
    await create(client) // B has a collection of their own
  }
  const leaks = (body: unknown, r: Setup) => {
    const text = JSON.stringify(body ?? null)
    return text.includes(r.id) || text.includes(r.title)
  }

  const routes: Array<[string, (b: Client, r: Setup) => Promise<ApiResponse>, number?]> = [
    ['GET /api/collections (B sees only their own)', (b) => b.get('/api/collections'), 200],
    ['GET /api/collections?status=archived', (b) => b.get('/api/collections?status=archived'), 200],
    ["GET /api/collections?cursor=<A's id>", (b, r) => b.get(`/api/collections?cursor=${r.id}`), 400],
    ['GET /api/collections/:id', (b, r) => b.get(`/api/collections/${r.id}`)],
    ['PATCH /api/collections/:id', (b, r) => b.patch(`/api/collections/${r.id}`, { title: 'Stolen' })],
    [
      'PATCH /api/collections/:id (languages)',
      (b, r) => b.patch(`/api/collections/${r.id}`, { nativeLanguage: 'fr', targetLanguage: 'en' }),
    ],
    ['POST /api/collections/:id/archive', (b, r) => b.post(`/api/collections/${r.id}/archive`)],
    ['POST /api/collections/:id/unarchive', (b, r) => b.post(`/api/collections/${r.id}/unarchive`)],
    [
      'DELETE /api/collections/:id (with the right title)',
      (b, r) => b.delete(`/api/collections/${r.id}`, { confirmTitle: r.title }),
    ],
    [
      'DELETE /api/collections/:id (with a wrong title: still 404, not 400)',
      (b, r) => b.delete(`/api/collections/${r.id}`, { confirmTitle: 'wrong' }),
    ],
  ]

  it.each(routes)('%s', async (_label, request, status) => {
    let resource: Setup | undefined
    await expectIdor<Setup>({
      setupA: async (a) => (resource = await setupA(a)),
      setupB,
      request: async (b, r) => track(await request(b, r)),
      status: status ?? 404,
      leaks,
    })
    // A's row is byte-identical afterwards.
    expect(await storedRow(resource!.id)).toBe(resource!.before)
  })

  it('a cursor that is not one of your collections is a 400 with a fixed message', async () => {
    const { client } = await signedIn()
    const res = await client.get(`/api/collections?cursor=${randomUUID()}`)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      statusCode: 400,
      message: 'Bad Request',
      issues: [{ path: 'cursor', message: COLLECTION_MESSAGES.invalidCursor }],
    })
  })
})

describe('validation (C3)', () => {
  it('same languages → 400 on targetLanguage', async () => {
    const { client } = await signedIn()
    const res = await client.post('/api/collections', {
      title: 'X',
      nativeLanguage: 'fr',
      targetLanguage: 'fr',
    })
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(res.body).issues).toEqual([
      { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
    ])
  })

  it('unsupported language → 400 with the fixed message', async () => {
    const { client } = await signedIn()
    const res = await client.post('/api/collections', {
      title: 'X',
      nativeLanguage: 'en',
      targetLanguage: 'de',
    })
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(res.body).issues).toEqual([
      { path: 'targetLanguage', message: LANGUAGE_MESSAGE },
    ])
  })

  it('extra keys → 400, and the key name and value are not echoed', async () => {
    const { client, userId } = await signedIn()
    const marker = 'zz-marker-<script>'
    for (const body of [
      { title: 'X', nativeLanguage: 'en', targetLanguage: 'fr', ownerId: userId },
      { title: 'X', nativeLanguage: 'en', targetLanguage: 'fr', normalization: { a: 1 } },
      { title: 'X', nativeLanguage: 'en', targetLanguage: 'fr', [marker]: marker },
    ]) {
      const res = await client.post('/api/collections', body)
      expect(res.status).toBe(400)
      apiErrorSchema.parse(res.body)
      expect(res.text).not.toContain('zz-marker')
      expect(res.text).not.toContain(userId)
    }
    const c = await create(client)
    const res = await client.patch(`/api/collections/${c.id}`, { archivedAt: null })
    expect(res.status).toBe(400)
  })

  it('a title too long, a control character, or an empty PATCH → 400', async () => {
    const { client } = await signedIn()
    const tooLong = await client.post('/api/collections', {
      title: 'x'.repeat(201),
      nativeLanguage: 'en',
      targetLanguage: 'fr',
    })
    expect(apiErrorSchema.parse(tooLong.body).issues).toEqual([
      { path: 'title', message: COLLECTION_MESSAGES.titleTooLong },
    ])
    expect(tooLong.text).not.toContain('xxxxxxxxxx')
    const control = await client.post('/api/collections', {
      title: 'a\u0000b',
      nativeLanguage: 'en',
      targetLanguage: 'fr',
    })
    expect(control.status).toBe(400)
    const c = await create(client)
    const empty = await client.patch(`/api/collections/${c.id}`, {})
    expect(apiErrorSchema.parse(empty.body).issues).toEqual([
      { path: '', message: COLLECTION_MESSAGES.noChanges },
    ])
  })

  it.each([
    ['GET', '/api/collections/not-a-uuid'],
    ['PATCH', '/api/collections/not-a-uuid'],
    ['DELETE', '/api/collections/not-a-uuid'],
    ['POST', '/api/collections/not-a-uuid/archive'],
    ['POST', '/api/collections/not-a-uuid/unarchive'],
  ])('non-uuid id: %s %s → 400', async (method, path) => {
    const { client } = await signedIn()
    const res = await client.send(
      method,
      path,
      method === 'GET' ? {} : { json: { title: 'x', confirmTitle: 'x' } },
    )
    expect(res.status).toBe(400)
    apiErrorSchema.parse(res.body)
    expect(res.text).not.toContain('not-a-uuid')
  })

  it.each(['limit=0', 'limit=51', 'status=deleted', 'cursor=abc', 'page=2', 'limit=1&limit=2'])(
    'bad list query %s → 400',
    async (query) => {
      const { client } = await signedIn()
      const res = await client.get(`/api/collections?${query}`)
      expect(res.status).toBe(400)
      apiErrorSchema.parse(res.body)
    },
  )

  it('unknown query parameters on item routes → 400; archive with a body field → 400', async () => {
    const { client } = await signedIn()
    const c = await create(client)
    expect((await client.get(`/api/collections/${c.id}?x=1`)).status).toBe(400)
    expect((await client.post(`/api/collections/${c.id}/archive`, { archivedAt: '2020-01-01' })).status).toBe(
      400,
    )
    expect((await client.post(`/api/collections/${c.id}/archive`, null)).status).toBe(400)
  })
})

describe('language lock (C4, RC002)', () => {
  it('PATCH languages with entries → 409 fixed message; a rename alone → 200', async () => {
    const { client } = await signedIn()
    const c = await create(client)
    await createEntry(migrator, c.id)

    const locked = await client.patch(`/api/collections/${c.id}`, {
      nativeLanguage: 'fr',
      targetLanguage: 'en',
    })
    expect(locked.status).toBe(409)
    expect(locked.body).toEqual({ statusCode: 409, message: COLLECTION_MESSAGES.languagesLocked })
    const single = await client.patch(`/api/collections/${c.id}`, { targetLanguage: 'en' })
    // Either check may fire first (CHECK on the row, or the trigger); both are fixed messages.
    expect([400, 409]).toContain(single.status)

    const title = uniqueTitle('Renamed')
    const renamed = await client.patch(`/api/collections/${c.id}`, { title })
    expect(renamed.status).toBe(200)
    expect(collectionSchema.parse(renamed.body)).toMatchObject({
      title,
      nativeLanguage: 'en',
      targetLanguage: 'fr',
      entryCount: 1,
    })
  })

  it('PATCH a single language equal to the other one (no entries) → 400 on targetLanguage', async () => {
    const { client } = await signedIn()
    const c = await create(client)
    const res = await client.patch(`/api/collections/${c.id}`, { targetLanguage: 'en' })
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(res.body).issues).toEqual([
      { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
    ])
  })
})

describe('delete confirmation (C5, D1)', () => {
  it('no body, {}, wrong title, or { confirm: true } → 400 and the row stays; the exact title → 204', async () => {
    const { client } = await signedIn()
    const c = await create(client)
    const cases: Array<unknown> = [
      undefined,
      {},
      { confirmTitle: c.title.toUpperCase() },
      { confirm: true },
      { confirmTitle: '' },
    ]
    for (const body of cases) {
      const res = await client.delete(`/api/collections/${c.id}`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      apiErrorSchema.parse(res.body)
      expect(res.text).not.toContain(c.title.toUpperCase())
      expect(await storedRow(c.id)).toBeDefined()
    }
    const mismatch = await client.delete(`/api/collections/${c.id}`, { confirmTitle: 'nope' })
    expect(mismatch.body).toEqual({
      statusCode: 400,
      message: 'Bad Request',
      issues: [{ path: 'confirmTitle', message: COLLECTION_MESSAGES.confirmMismatch }],
    })

    // Surrounding whitespace is trimmed, like the title itself.
    const ok = await client.delete(`/api/collections/${c.id}`, { confirmTitle: ` ${c.title} ` })
    expect(ok.status).toBe(204)
    expect(await storedRow(c.id)).toBeUndefined()
  })
})

describe('pagination (C6)', () => {
  it('25 items, limit=10 → 10/10/5, nextCursor null on the last page', async () => {
    const { client } = await signedIn()
    const created: string[] = []
    for (let i = 0; i < 25; i++) created.push((await create(client)).id)

    const seen: string[] = []
    const sizes: number[] = []
    let cursor: string | null = null
    do {
      const res = track(await client.get(`/api/collections?limit=10${cursor ? `&cursor=${cursor}` : ''}`))
      expect(res.status).toBe(200)
      const page = collectionListSchema.parse(res.body)
      sizes.push(page.items.length)
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor && sizes.length < 5)
    expect(sizes).toEqual([10, 10, 5])
    expect(new Set(seen).size).toBe(25)
    expect([...seen].sort()).toEqual([...created].sort())
  })
})

describe('no owner data in responses (C7)', () => {
  it('created owner_id is always the session user; no ownerId/normalization anywhere', async () => {
    const { client, userId } = await signedIn()
    const other = await signedIn()
    // Trying to set the owner is a 400, not a silent override.
    const res = await client.post('/api/collections', {
      title: 'X',
      nativeLanguage: 'en',
      targetLanguage: 'fr',
      ownerId: other.userId,
    })
    expect(res.status).toBe(400)

    const c = await create(client)
    const [row] = await migrator<{ owner_id: string }[]>`select owner_id from collections where id = ${c.id}`
    expect(row!.owner_id).toBe(userId)
    const [n] = await migrator<
      { n: number }[]
    >`select count(*)::int as n from collections where owner_id = ${other.userId}`
    expect(n!.n).toBe(0)

    track(await client.get(`/api/collections/${c.id}`))
    track(await client.get('/api/collections'))
    for (const body of allBodies) expect(ownerKeys(body)).toEqual([])
    for (const body of allBodies) expect(JSON.stringify(body ?? null)).not.toContain('owner')
  })
})

describe('CSRF and content type (C8)', () => {
  it.each([
    ['POST', '/api/collections'],
    ['PATCH', '/api/collections/:id'],
    ['DELETE', '/api/collections/:id'],
    ['POST', '/api/collections/:id/archive'],
  ])('%s %s: foreign Origin → 403, text/plain → 415, nothing changes', async (method, pattern) => {
    const { client } = await signedIn()
    const c = await create(client)
    const path = pattern.replace(':id', c.id)
    const before = await storedRow(c.id)
    const body = JSON.stringify({
      title: 'Changed',
      nativeLanguage: 'en',
      targetLanguage: 'fr',
      confirmTitle: c.title,
    })

    const foreign = await client.send(method, path, {
      body,
      headers: { 'content-type': 'application/json' },
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(403)
    const plain = await client.send(method, path, { body, headers: { 'content-type': 'text/plain' } })
    expect(plain.status).toBe(415)
    expect(await storedRow(c.id)).toBe(before)
  })
})

describe('audit (C9)', () => {
  it('collection.deleted and access.denied (resource collection) are logged, never titles', async () => {
    const { client, userId } = await signedIn()
    const c = await create(client)
    const intruder = await signedIn()

    const denied = await intruder.client.get(`/api/collections/${c.id}`)
    expect(denied.status).toBe(404)
    const deniedLine = await waitForAudit(
      (l) => l.requestId === denied.requestId && l.event === 'access.denied',
    )
    expect(deniedLine).toMatchObject({ reason: 'not_owner', resource: 'collection', userId: intruder.userId })

    const del = await client.delete(`/api/collections/${c.id}`, { confirmTitle: c.title })
    expect(del.status).toBe(204)
    const deletedLine = await waitForAudit(
      (l) => l.requestId === del.requestId && l.event === 'collection.deleted',
    )
    expect(deletedLine).toMatchObject({ level: 'info', resource: 'collection', userId })

    // A failed confirmation is not a deletion.
    const c2 = await create(client)
    const failed = await client.delete(`/api/collections/${c2.id}`, { confirmTitle: 'nope' })
    expect(failed.status).toBe(400)
    await new Promise((r) => setTimeout(r, 300))
    expect(
      auditLines().some((l) => l.requestId === failed.requestId && l.event === 'collection.deleted'),
    ).toBe(false)

    const log = readServerLog()
    for (const title of titles)
      expect(log.includes(title), 'a collection title appears in the server log').toBe(false)
  })
})
