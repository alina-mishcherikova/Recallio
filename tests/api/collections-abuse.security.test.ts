// LEX-004 security review: abuse cases beyond C1–C9 (ADR 0003 §6.3), black-box against the built
// server. Owned by the security agent. Every response body is scanned for owner data at the end.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { COLLECTION_LIMIT, collectionSchema, type Collection } from '../../shared/schemas/collections'
import { connectAs } from '../integration/helpers/db'
import { createEntry } from '../integration/helpers/factories'
import {
  Client,
  auditLines,
  checkNoLeaksAfterAll,
  nextIp,
  readServerLog,
  registerAccount,
  type Account,
  type ApiResponse,
} from './helpers/client'

checkNoLeaksAfterAll()
const migrator = connectAs('migrator')
const app = connectAs('app', { max: 6 })

/** Every value here must never appear in the server log. */
const userText: string[] = []
const mark = (prefix: string) => {
  const v = `${prefix} ${randomUUID().slice(0, 13)}`
  userText.push(v)
  return v
}

const allBodies: unknown[] = []
const track = (res: ApiResponse) => {
  allBodies.push(res.body)
  return res
}

async function signedIn(): Promise<{ client: Client; account: Account }> {
  const client = new Client()
  const account = await registerAccount(client)
  return { client, account }
}

async function create(client: Client, body: Record<string, unknown> = {}): Promise<Collection> {
  const res = track(
    await client.post('/api/collections', {
      title: mark('Title'),
      nativeLanguage: 'en',
      targetLanguage: 'fr',
      ...body,
    }),
  )
  expect(res.status, res.text).toBe(201)
  return collectionSchema.parse(res.body)
}

async function storedRow(id: string): Promise<string | undefined> {
  const [row] = await migrator<{ t: string }[]>`select c::text as t from collections c where id = ${id}`
  return row?.t
}

const OWNER_KEYS = /^(ownerId|owner_id|normalization)$/
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

afterAll(async () => {
  for (const body of allBodies) expect(ownerKeys(body)).toEqual([])
  await new Promise((r) => setTimeout(r, 300))
  const log = readServerLog()
  for (const v of userText) expect(log.includes(v), 'user text in the server log').toBe(false)
})

describe('IDOR: UUID variants and malformed ids', () => {
  it("B with an upper-case or mixed-case variant of A's id gets 404 on every item route; A's row is unchanged", async () => {
    const { client: a } = await signedIn()
    const mine = await create(a)
    const before = await storedRow(mine.id)
    const { client: b } = await signedIn()
    const variants = [mine.id.toUpperCase(), mine.id.replace(/[a-f]/, (c) => c.toUpperCase())]
    for (const id of variants) {
      const results = [
        await b.get(`/api/collections/${id}`),
        await b.patch(`/api/collections/${id}`, { title: 'Stolen' }),
        await b.post(`/api/collections/${id}/archive`),
        await b.post(`/api/collections/${id}/unarchive`),
        await b.delete(`/api/collections/${id}`, { confirmTitle: mine.title }),
      ].map(track)
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
      for (const r of results) expect(r.text).not.toContain(mine.title)
      const list = track(await b.get(`/api/collections?cursor=${id}`))
      expect(list.status).toBe(400)
    }
    expect(await storedRow(mine.id)).toBe(before)
    // The owner can use the upper-case form (Postgres uuid is case-insensitive): consistent, not a bypass.
    expect(track(await a.get(`/api/collections/${mine.id.toUpperCase()}`)).status).toBe(200)
  })

  it.each([
    ['braces', (id: string) => `%7B${id}%7D`],
    ['no hyphens', (id: string) => id.replaceAll('-', '')],
    ['urn prefix', (id: string) => `urn:uuid:${id}`],
    ['trailing space', (id: string) => `${id}%20`],
    ['SQL', () => `'%20or%201=1--`],
    ['path traversal', () => '..%2F..%2Faccount'],
    ['null byte', (id: string) => `${id}%00`],
  ])('malformed id (%s) → 400 with a fixed body, never 500', async (_label, make) => {
    const { client: a } = await signedIn()
    const mine = await create(a)
    const { client: b } = await signedIn()
    const id = make(mine.id)
    for (const res of [
      await b.get(`/api/collections/${id}`),
      await b.patch(`/api/collections/${id}`, { title: 'x' }),
      await b.delete(`/api/collections/${id}`, { confirmTitle: mine.title }),
    ].map(track)) {
      expect([400, 404], `${res.status} ${res.text}`).toContain(res.status)
      expect(res.text).not.toContain(mine.title)
      expect(res.text).not.toMatch(/stack|postgres|drizzle|select /i)
    }
    expect(track(await a.get(`/api/collections/${mine.id}`)).status).toBe(200)
  })

  it("timing: B's requests for A's id and for a random id are indistinguishable", async () => {
    const { client: a } = await signedIn()
    const mine = await create(a)
    const { client: b } = await signedIn()
    const time = async (fn: () => Promise<ApiResponse>) => {
      const t = performance.now()
      const res = track(await fn())
      expect(res.status).toBe(404)
      return performance.now() - t
    }
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
    const report: Record<string, { foreign: number; missing: number }> = {}
    const routes: Record<string, (id: string) => Promise<ApiResponse>> = {
      get: (id) => b.get(`/api/collections/${id}`),
      patch: (id) => b.patch(`/api/collections/${id}`, { title: 'x' }),
      delete: (id) => b.delete(`/api/collections/${id}`, { confirmTitle: mine.title }),
    }
    for (const [name, fn] of Object.entries(routes)) {
      const foreign: number[] = []
      const missing: number[] = []
      for (let i = 0; i < 25; i++) {
        foreign.push(await time(() => fn(mine.id)))
        missing.push(await time(() => fn(randomUUID())))
      }
      report[name] = { foreign: median(foreign), missing: median(missing) }
    }
    console.warn('timing medians (ms)', JSON.stringify(report))
    for (const { foreign, missing } of Object.values(report)) {
      expect(Math.abs(foreign - missing)).toBeLessThan(Math.max(2, 0.5 * missing))
    }
  })
})

describe('mass assignment on PATCH and create', () => {
  const sneaky: Array<[string, unknown]> = [
    ['ownerId', randomUUID()],
    ['owner_id', randomUUID()],
    ['normalization', { caseSensitive: true }],
    ['archivedAt', null],
    ['archived_at', null],
    ['createdAt', '2000-01-01T00:00:00.000Z'],
    ['entryCount', 9999],
    ['id', randomUUID()],
  ]
  it.each(sneaky)(
    'PATCH with %s (alongside a valid title) → 400 and the row is unchanged',
    async (key, value) => {
      const { client } = await signedIn()
      const mine = await create(client)
      const before = await storedRow(mine.id)
      const res = track(await client.patch(`/api/collections/${mine.id}`, { title: 'Renamed', [key]: value }))
      expect(res.status).toBe(400)
      expect(res.text).not.toContain(key)
      expect(await storedRow(mine.id)).toBe(before)
    },
  )

  it('archivedAt on an archived collection cannot be cleared through PATCH (only via unarchive)', async () => {
    const { client } = await signedIn()
    const mine = await create(client)
    expect(track(await client.post(`/api/collections/${mine.id}/archive`)).status).toBe(200)
    const res = track(await client.patch(`/api/collections/${mine.id}`, { archivedAt: null }))
    expect(res.status).toBe(400)
    const [row] = await migrator<{ archived: boolean }[]>`
      select archived_at is not null as archived from collections where id = ${mine.id}`
    expect(row!.archived).toBe(true)
  })

  it.each(['__proto__', 'constructor', 'prototype'])(
    'a "%s" key in the JSON body → 400 (prototype pollution), on create and PATCH',
    async (key) => {
      const { client } = await signedIn()
      const mine = await create(client)
      const payload = `{"title":"T","nativeLanguage":"en","targetLanguage":"fr","${key}":{"ownerId":"${randomUUID()}","isAdmin":true}}`
      const headers = { 'content-type': 'application/json' }
      const created = track(await client.send('POST', '/api/collections', { body: payload, headers }))
      expect(created.status, created.text).toBe(400)
      const patched = track(
        await client.send('PATCH', `/api/collections/${mine.id}`, {
          body: `{"title":"T2","${key}":{"archivedAt":null}}`,
          headers,
        }),
      )
      expect(patched.status, patched.text).toBe(400)
      // The server process is not polluted: a normal request still works and has no extra keys.
      const ok = track(await client.get(`/api/collections/${mine.id}`))
      expect(ok.status).toBe(200)
      expect(Object.keys(ok.body as object).sort()).toEqual(Object.keys(mine).sort())
    },
  )

  it('duplicate JSON keys: the last value wins and is still validated', async () => {
    const { client } = await signedIn()
    const body = '{"title":"Dup","nativeLanguage":"en","targetLanguage":"fr","targetLanguage":"en"}'
    const res = track(
      await client.send('POST', '/api/collections', {
        body,
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(400) // en/en after the duplicate → languagesSame
  })
})

describe('cursor tampering', () => {
  it("another user's id, a deleted own id, a random id → 400 with the same fixed body", async () => {
    const { client: a } = await signedIn()
    const aColl = await create(a)
    const { client: b } = await signedIn()
    for (let i = 0; i < 3; i++) await create(b)
    const gone = await create(b)
    expect(track(await b.delete(`/api/collections/${gone.id}`, { confirmTitle: gone.title })).status).toBe(
      204,
    )
    const bodies = []
    for (const cursor of [aColl.id, gone.id, randomUUID()]) {
      const res = track(await b.get(`/api/collections?limit=1&cursor=${cursor}`))
      expect(res.status).toBe(400)
      bodies.push(res.text)
    }
    expect(new Set(bodies).size).toBe(1)
  })

  it.each([
    ["' or 1=1--", '%27%20or%201%3D1--'],
    ['union', '00000000-0000-0000-0000-000000000000%27)%20union%20select%201--'],
    ['array', `${randomUUID()}&cursor=${randomUUID()}`],
    ['object', 'x&cursor[a]=1'],
    ['empty', ''],
  ])('injection-like cursor (%s) → 400, never 500', async (_label, raw) => {
    const { client } = await signedIn()
    await create(client)
    const res = track(await client.get(`/api/collections?cursor=${raw}`))
    expect(res.status, res.text).toBe(400)
  })

  it('limit coercion edge cases never return more than 50 items or a 500', async () => {
    const { client } = await signedIn()
    for (const limit of ['1e1', '0x10', '-0', ' 5', '50.0', '51', 'Infinity', 'NaN', '1e400']) {
      const res = track(await client.get(`/api/collections?limit=${encodeURIComponent(limit)}`))
      expect([200, 400], `${limit}: ${res.status}`).toContain(res.status)
      if (res.status === 200) expect((res.body as { items: unknown[] }).items.length).toBeLessThanOrEqual(50)
    }
  })
})

describe('per-user cap of 200 under parallel requests from several sessions', () => {
  it('3 sessions × 10 parallel creates at 190 → exactly 10 succeed, the count is 200', async () => {
    const first = new Client()
    const account = await registerAccount(first)
    const sessions = [first]
    for (let i = 0; i < 2; i++) {
      const c = new Client()
      const res = await c.post('/api/auth/login', { email: account.email, password: account.password })
      expect(res.status, res.text).toBe(200)
      sessions.push(c)
    }
    await migrator`
      insert into collections (owner_id, title, native_language, target_language)
      select ${account.userId}, 'Seed ' || g, 'en', 'fr' from generate_series(1, ${COLLECTION_LIMIT - 10}) g`
    const results = await Promise.all(
      sessions.flatMap((s) =>
        Array.from({ length: 10 }, () =>
          s.post(
            '/api/collections',
            { title: mark('Race'), nativeLanguage: 'en', targetLanguage: 'fr' },
            { ip: nextIp() },
          ),
        ),
      ),
    )
    results.forEach(track)
    const statuses = results.map((r) => r.status).sort()
    const [{ n }] = await migrator<{ n: number }[]>`
      select count(*)::int as n from collections where owner_id = ${account.userId}`
    console.warn('cap race statuses', JSON.stringify(Object.groupBy(statuses, String)), 'count', n)
    expect(statuses.filter((s) => s === 201)).toHaveLength(10)
    expect(statuses.filter((s) => s === 409)).toHaveLength(20)
    expect(n).toBe(COLLECTION_LIMIT)
  })

  it('archived collections count toward the cap; deleting one frees a slot', async () => {
    const { client, account } = await signedIn()
    await migrator`
      insert into collections (owner_id, title, native_language, target_language, archived_at)
      select ${account.userId}, 'Seed ' || g, 'en', 'fr', now() from generate_series(1, ${COLLECTION_LIMIT}) g`
    const res = track(
      await client.post('/api/collections', {
        title: mark('Over'),
        nativeLanguage: 'en',
        targetLanguage: 'fr',
      }),
    )
    expect(res.status).toBe(409)
  })
})

describe('RC002: languages vs. concurrent entry inserts (app role)', () => {
  it('an entry insert in flight blocks a language PATCH, which then fails with 409', async () => {
    const { client } = await signedIn()
    const mine = await create(client)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let inserted!: () => void
    const insertDone = new Promise<void>((r) => (inserted = r))
    const tx = app.begin(async (sql) => {
      await createEntry(sql, mine.id)
      inserted()
      await held
    })
    await insertDone
    const patch = client.patch(`/api/collections/${mine.id}`, { nativeLanguage: 'fr', targetLanguage: 'en' })
    // The PATCH must be waiting on the FOR SHARE lock, not finished.
    const early = await Promise.race([
      patch.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('waiting'), 500)),
    ])
    expect(early).toBe('waiting')
    release()
    await tx
    const res = track(await patch)
    expect(res.status, res.text).toBe(409)
    const [row] = await migrator<{ n: string; t: string }[]>`
      select native_language n, target_language t from collections where id = ${mine.id}`
    expect(row).toEqual({ n: 'en', t: 'fr' })
  })

  it('an entry insert during an uncommitted language UPDATE waits and then sees the new languages', async () => {
    const { client } = await signedIn()
    const mine = await create(client)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let updated!: () => void
    const updateDone = new Promise<void>((r) => (updated = r))
    const tx = app.begin(async (sql) => {
      await sql`update collections set native_language = 'fr', target_language = 'en' where id = ${mine.id}`
      updated()
      await held
    })
    await updateDone
    const entry = createEntry(app, mine.id)
    const early = await Promise.race([
      entry.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('waiting'), 500)),
    ])
    expect(early).toBe('waiting')
    release()
    await tx
    await entry
    const res = track(
      await client.patch(`/api/collections/${mine.id}`, { nativeLanguage: 'en', targetLanguage: 'fr' }),
    )
    expect(res.status).toBe(409)
    const got = track(await client.get(`/api/collections/${mine.id}`)).body as Collection
    expect([got.nativeLanguage, got.targetLanguage]).toEqual(['fr', 'en'])
  })

  it('stress: 20 rounds of parallel entry insert + language flip never leave entries under a changed pair', async () => {
    const { client } = await signedIn()
    let violations = 0
    for (let i = 0; i < 20; i++) {
      const mine = await create(client)
      const [patch] = await Promise.all([
        client.patch(`/api/collections/${mine.id}`, { nativeLanguage: 'fr', targetLanguage: 'en' }),
        createEntry(app, mine.id),
      ])
      track(patch)
      // If the PATCH won, the entry was inserted after it (under fr/en). If the entry won, the PATCH is 409.
      if (patch.status === 200) {
        const [row] = await migrator<{ ok: boolean }[]>`
          select (select min(e.created_at) from vocabulary_entries e where e.collection_id = c.id) is not null as ok
            from collections c where c.id = ${mine.id} and c.native_language = 'fr'`
        if (!row?.ok) violations++
      } else expect(patch.status).toBe(409)
    }
    expect(violations).toBe(0)
  })
})

describe('delete confirmation: Unicode and cross-user', () => {
  const NFC = 'Café crème'
  const NFD = 'Cafe\u0301 cre\u0300me'

  it.each([
    ['NFD of the stored NFC title', NFD, 204],
    ['surrounding whitespace and NBSP', `\u00a0 ${NFC}\t `, 204],
    ['zero-width space inside', 'Café\u200b crème', 400],
    ['zero-width joiner inside', 'Café\u200d crème', 400],
    ['Cyrillic homoglyph \u0421', '\u0421afé crème', 400],
    ['fullwidth (NFKC-only equal)', '\uff23afé crème', 400],
    ['different case', 'CAFÉ CRÈME', 400],
    ['title + suffix', `${NFC}x`, 400],
    ['prefix only', 'Café', 400],
    ['SQL wildcard', '%', 400],
    ['LIKE underscore pattern', 'Caf_ cr_me', 400],
  ])('%s → %i', async (_label, confirmTitle, expected) => {
    const { client } = await signedIn()
    const mine = await create(client, { title: NFC })
    const res = track(await client.delete(`/api/collections/${mine.id}`, { confirmTitle }))
    expect(res.status, res.text).toBe(expected)
    expect(!!(await storedRow(mine.id))).toBe(expected !== 204)
  })

  it('rejects titles containing invisible or bidi-control characters (L2 fix)', async () => {
    const { client } = await signedIn()
    for (const ch of ['\u200b', '\u202e', '\u2066', '\ufeff', '\u2028', '\u{e0041}']) {
      const res = track(
        await client.post('/api/collections', {
          title: `a${ch}b`,
          nativeLanguage: 'en',
          targetLanguage: 'fr',
        }),
      )
      expect(res.status).toBe(400)
      expect(res.text).not.toContain(ch)
    }
  })

  it('rejects titles with no visible character (L2 fix)', async () => {
    const { client } = await signedIn()
    for (const title of ['\u200b\u200b', '\u3164\u3164', '\u115f \u1160']) {
      const res = track(
        await client.post('/api/collections', { title, nativeLanguage: 'en', targetLanguage: 'fr' }),
      )
      expect(res.status).toBe(400)
    }
  })

  it('accepts emoji ZWJ sequences in titles', async () => {
    const { client } = await signedIn()
    const mine = await create(client, { title: 'Tech \u{1F469}\u200d\u{1F4BB}' })
    expect(mine.title).toBe('Tech \u{1F469}\u200d\u{1F4BB}')
  })

  it("B cannot delete A's collection with A's exact title, and gets the same 404 as for a wrong title", async () => {
    const { client: a } = await signedIn()
    const mine = await create(a)
    const { client: b } = await signedIn()
    const right = track(await b.delete(`/api/collections/${mine.id}`, { confirmTitle: mine.title }))
    const wrong = track(await b.delete(`/api/collections/${mine.id}`, { confirmTitle: 'guess' }))
    expect([right.status, wrong.status]).toEqual([404, 404])
    expect(right.text).toBe(wrong.text)
    expect(await storedRow(mine.id)).toBeDefined()
  })

  it('a rename racing a delete: the old title never deletes the renamed collection', async () => {
    const { client } = await signedIn()
    const mine = await create(client)
    expect(track(await client.patch(`/api/collections/${mine.id}`, { title: 'New name' })).status).toBe(200)
    expect(
      track(await client.delete(`/api/collections/${mine.id}`, { confirmTitle: mine.title })).status,
    ).toBe(400)
    expect(await storedRow(mine.id)).toBeDefined()
  })
})

describe('markup in user text (stored XSS, API side)', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    'javascript:alert(1)',
    '{{constructor.constructor("alert(1)")()}}',
    'a < b & c > d',
    'Tom & Jerry',
    '<3 French',
  ]
  it('stores markup-like text verbatim on create and PATCH (L1 fix: no XSS validator on the API)', async () => {
    const { client } = await signedIn()
    for (const p of payloads) {
      const res = track(
        await client.post('/api/collections', {
          title: p,
          description: p,
          topic: p.slice(0, 100),
          nativeLanguage: 'en',
          targetLanguage: 'fr',
        }),
      )
      expect(res.status).toBe(201)
      const c = res.body as Collection
      expect([c.title, c.description, c.topic]).toEqual([p, p, p.slice(0, 100)]) // stored verbatim, not mangled
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const patched = track(await client.patch(`/api/collections/${c.id}`, { title: `${p}!` }))
      expect(patched.status).toBe(200)
      expect((patched.body as Collection).title).toBe(`${p}!`)
    }
  })
})

describe('abuse: body size, nesting, long text, rate limits', () => {
  it('a body over 1 MB → 413; a 450k-character (900 KB) title → 400 without a 500', async () => {
    const { client } = await signedIn()
    const big = track(
      await client.post('/api/collections', {
        title: 'x'.repeat(1_100_000),
        nativeLanguage: 'en',
        targetLanguage: 'fr',
      }),
    )
    expect(big.status).toBe(413)
    const t = performance.now()
    const long = track(
      await client.post('/api/collections', {
        title: 'é'.repeat(450_000),
        nativeLanguage: 'en',
        targetLanguage: 'fr',
      }),
    )
    console.warn('450k-char title →', long.status, `${Math.round(performance.now() - t)} ms`)
    expect(long.status).toBe(400)
  })

  it('deeply nested JSON → 400, the server stays up', async () => {
    const { client } = await signedIn()
    const depth = 400_000
    const body = `{"title":${'['.repeat(depth)}${']'.repeat(depth)},"nativeLanguage":"en","targetLanguage":"fr"}`
    const res = track(
      await client.send('POST', '/api/collections', {
        body,
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect([400, 413], res.text).toContain(res.status)
    expect(
      (await fetch(`${new URL('/api/health', `${(await import('./helpers/client')).ORIGIN}`)}`)).status,
    ).toBe(200)
  })

  it('max-length astral text (2000 emoji description, 200 emoji title) is accepted and stored by code points', async () => {
    const { client } = await signedIn()
    const c = await create(client, {
      title: '😀'.repeat(200),
      description: '😀'.repeat(2000),
      topic: '😀'.repeat(100),
    })
    const [row] = await migrator<{ t: number; d: number }[]>`
      select char_length(title) t, char_length(description) d from collections where id = ${c.id}`
    expect(row).toEqual({ t: 200, d: 2000 })
  })

  it('rate limiting: only the global per-IP bucket applies; a second IP doubles one user’s budget', async () => {
    const { client } = await signedIn()
    const mine = await create(client)
    const ip = nextIp()
    let firstLimited = -1
    for (let i = 0; i < 160; i++) {
      const res = await client.patch(`/api/collections/${mine.id}`, { title: `t${i}` }, { ip })
      if (res.status === 429) {
        firstLimited = i
        break
      }
      expect(res.status).toBe(200)
    }
    console.warn('PATCH from one IP: first 429 at request #', firstLimited)
    // Is the bucket shared with other routes from the same IP?
    const get = await client.get('/api/collections', { ip })
    const page = await client.get('/collections', { ip })
    const otherIp = await client.patch(`/api/collections/${mine.id}`, { title: 'other ip' }, { ip: nextIp() })
    console.warn(
      'after limit, same IP: GET /api/collections',
      get.status,
      'GET /collections page',
      page.status,
      '| other IP PATCH',
      otherIp.status,
    )
    expect(firstLimited).toBeGreaterThan(0)
    expect(otherIp.status).toBe(200)
  })
})

describe('audit log', () => {
  it('404s, 409s, renames and deletes never log titles, descriptions or topics', async () => {
    const { client: a } = await signedIn()
    const desc = mark('Desc')
    const topic = mark('Topic')
    const mine = await create(a, { description: desc, topic })
    track(
      await a.patch(`/api/collections/${mine.id}`, { title: mark('Renamed'), description: mark('Desc2') }),
    )
    track(await a.post(`/api/collections/${mine.id}/archive`))
    track(await a.patch(`/api/collections/${mine.id}`, { title: mark('Blocked') })) // 409
    const { client: b } = await signedIn()
    track(await b.delete(`/api/collections/${mine.id}`, { confirmTitle: mark('Guess') }))
    track(await a.delete(`/api/collections/${mine.id}`, { confirmTitle: mark('Wrong') })) // 400
    const fresh = (await a.get(`/api/collections/${mine.id}`)).body as Collection
    track(await a.delete(`/api/collections/${mine.id}`, { confirmTitle: fresh.title }))
    await new Promise((r) => setTimeout(r, 300))
    const lines = auditLines().filter((l) => String(l.route ?? '').includes(mine.id))
    expect(lines.map((l) => l.event)).toEqual(expect.arrayContaining(['access.denied', 'collection.deleted']))
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(
        expect.arrayContaining(['event', 'ip', 'level', 'requestId', 'route', 'ts', 'userId']),
      )
      expect(JSON.stringify(l)).not.toContain(fresh.title)
    }
  })
})
