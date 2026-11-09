// U1–U8, U10 (ADR 0003 §6.1): collection contracts are strict, bounded in code points, and the DTO
// never carries ownerId or normalization.
import { describe, expect, it } from 'vitest'
import { LANGUAGE_MESSAGE } from '../../../shared/constants/languages'
import {
  COLLECTION_MESSAGES,
  collectionIdParamsSchema,
  collectionListSchema,
  collectionSchema,
  createCollectionSchema,
  deleteCollectionSchema,
  emptyBodySchema,
  listCollectionsQuerySchema,
  updateCollectionSchema,
} from '../../../shared/schemas/collections'
import { toCollectionDto, type CollectionRow } from '../../../server/services/collections/dto'
import { zodIssuesToPublic } from '../../../server/utils/errors'
import type { ZodType } from '../../../shared/zod'

const valid = { title: 'Animals', nativeLanguage: 'en', targetLanguage: 'fr' }

function issues(schema: ZodType, input: unknown): { path: string; message: string }[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  return schema.parse(input)
}

describe('createCollectionSchema', () => {
  it('U1: missing fields → one issue per field', () => {
    const found = issues(createCollectionSchema, {})
    expect(found.map((i) => i.path).sort()).toEqual(['nativeLanguage', 'targetLanguage', 'title'])
    expect(found.find((i) => i.path === 'title')?.message).toBe(COLLECTION_MESSAGES.titleRequired)
  })

  it('U1: same languages → languagesSame on targetLanguage', () => {
    expect(issues(createCollectionSchema, { ...valid, nativeLanguage: 'fr', targetLanguage: 'fr' })).toEqual([
      { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
    ])
  })

  it('U1: same languages are reported together with other field errors', () => {
    const found = issues(createCollectionSchema, { title: ' ', nativeLanguage: 'fr', targetLanguage: 'fr' })
    expect(found).toEqual(
      expect.arrayContaining([
        { path: 'title', message: COLLECTION_MESSAGES.titleRequired },
        { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
      ]),
    )
  })

  it.each(['de', 'EN', 'fra', '', null, 1])('U2: language %j rejected with LANGUAGE_MESSAGE', (code) => {
    expect(issues(createCollectionSchema, { ...valid, targetLanguage: code })).toEqual([
      { path: 'targetLanguage', message: LANGUAGE_MESSAGE },
    ])
    expect(issues(createCollectionSchema, { ...valid, nativeLanguage: code })).toEqual([
      { path: 'nativeLanguage', message: LANGUAGE_MESSAGE },
    ])
  })

  it.each(['', '   ', '\t\n'])('U3: blank title %j rejected', (title) => {
    expect(issues(createCollectionSchema, { ...valid, title })).toEqual([
      { path: 'title', message: COLLECTION_MESSAGES.titleRequired },
    ])
  })

  it('U3: 200 code points accepted, 201 rejected (emoji count as one)', () => {
    expect(parse(createCollectionSchema, { ...valid, title: '😀'.repeat(200) }).title).toHaveLength(400)
    expect(issues(createCollectionSchema, { ...valid, title: '😀'.repeat(201) })).toEqual([
      { path: 'title', message: COLLECTION_MESSAGES.titleTooLong },
    ])
    expect(parse(createCollectionSchema, { ...valid, title: 'a'.repeat(200) }).title).toHaveLength(200)
    expect(issues(createCollectionSchema, { ...valid, title: 'a'.repeat(201) })).toHaveLength(1)
  })

  it('U3: NFC is applied before counting (decomposed é counts as one)', () => {
    const decomposed = 'é'.repeat(200) // 400 UTF-16 units, 200 code points after NFC
    const out = parse(createCollectionSchema, { ...valid, title: decomposed })
    expect(out.title).toBe('é'.repeat(200))
    // A combining mark with no precomposed form stays two code points: 101 × 2 = 202 > 200.
    expect(issues(createCollectionSchema, { ...valid, title: 'q̇'.repeat(101) })).toEqual([
      { path: 'title', message: COLLECTION_MESSAGES.titleTooLong },
    ])
  })

  it('U3: trims, and rejects control characters', () => {
    expect(parse(createCollectionSchema, { ...valid, title: '  Animals  ' }).title).toBe('Animals')
    for (const title of ['a\u0000b', 'a\nb', 'a\u0007', 'a\u007f', 'a\u0085b', 'a\ud800b']) {
      expect(issues(createCollectionSchema, { ...valid, title })).toEqual([
        { path: 'title', message: COLLECTION_MESSAGES.invalidCharacters },
      ])
    }
  })

  it('U4: description 2000/2001, newlines allowed, CRLF normalized', () => {
    expect(
      parse(createCollectionSchema, { ...valid, description: 'd'.repeat(2000) }).description,
    ).toHaveLength(2000)
    expect(issues(createCollectionSchema, { ...valid, description: 'd'.repeat(2001) })).toEqual([
      { path: 'description', message: COLLECTION_MESSAGES.descriptionTooLong },
    ])
    expect(parse(createCollectionSchema, { ...valid, description: 'a\r\nb' }).description).toBe('a\nb')
    expect(issues(createCollectionSchema, { ...valid, description: 'a\tb' })).toEqual([
      { path: 'description', message: COLLECTION_MESSAGES.invalidCharacters },
    ])
  })

  it('U4: topic 100/101', () => {
    expect(parse(createCollectionSchema, { ...valid, topic: 't'.repeat(100) }).topic).toHaveLength(100)
    expect(issues(createCollectionSchema, { ...valid, topic: 't'.repeat(101) })).toEqual([
      { path: 'topic', message: COLLECTION_MESSAGES.topicTooLong },
    ])
  })

  it("U4: '' and blank → null; null stays null; omitted stays omitted", () => {
    const out = parse(createCollectionSchema, { ...valid, description: '  ', topic: '' })
    expect(out.description).toBeNull()
    expect(out.topic).toBeNull()
    expect(parse(createCollectionSchema, { ...valid, description: null, topic: null })).toMatchObject({
      description: null,
      topic: null,
    })
    const omitted = parse(createCollectionSchema, valid)
    expect('description' in omitted).toBe(false)
    expect(issues(createCollectionSchema, { ...valid, topic: 5 })).toEqual([
      { path: 'topic', message: COLLECTION_MESSAGES.invalidText },
    ])
  })

  it.each(['ownerId', 'owner_id', 'archivedAt', 'normalization', 'id', 'entryCount'])(
    'U5: unknown key %s rejected on create and update',
    (key) => {
      expect(createCollectionSchema.safeParse({ ...valid, [key]: 'x' }).success).toBe(false)
      expect(updateCollectionSchema.safeParse({ title: 'x', [key]: 'x' }).success).toBe(false)
    },
  )
})

describe('updateCollectionSchema', () => {
  it('U6: {} rejected', () => {
    expect(issues(updateCollectionSchema, {})).toEqual([{ path: '', message: COLLECTION_MESSAGES.noChanges }])
  })

  it('U6: both languages equal rejected; a single language accepted', () => {
    expect(issues(updateCollectionSchema, { nativeLanguage: 'en', targetLanguage: 'en' })).toEqual([
      { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
    ])
    expect(parse(updateCollectionSchema, { targetLanguage: 'en' })).toEqual({ targetLanguage: 'en' })
    expect(parse(updateCollectionSchema, { nativeLanguage: 'fr', targetLanguage: 'en' })).toEqual({
      nativeLanguage: 'fr',
      targetLanguage: 'en',
    })
  })

  it('applies the same field rules as create', () => {
    expect(issues(updateCollectionSchema, { title: ' ' })).toEqual([
      { path: 'title', message: COLLECTION_MESSAGES.titleRequired },
    ])
    expect(parse(updateCollectionSchema, { topic: ' ' })).toEqual({ topic: null })
  })
})

describe('listCollectionsQuerySchema (U7)', () => {
  it('defaults', () => {
    expect(parse(listCollectionsQuerySchema, {})).toEqual({ status: 'active', limit: 20 })
  })

  it.each([{ limit: '0' }, { limit: '51' }, { limit: '1.5' }, { limit: 'abc' }, { limit: ['1', '2'] }])(
    'rejects %j',
    (q) => {
      expect(listCollectionsQuerySchema.safeParse(q).success).toBe(false)
    },
  )

  it('coerces limit from the query string', () => {
    expect(parse(listCollectionsQuerySchema, { limit: '50', status: 'archived' })).toEqual({
      limit: 50,
      status: 'archived',
    })
  })

  it.each([{ status: 'deleted' }, { status: 'ACTIVE' }, { cursor: 'abc' }, { cursor: '1' }, { page: '2' }])(
    'rejects %j',
    (q) => {
      expect(listCollectionsQuerySchema.safeParse(q).success).toBe(false)
    },
  )
})

describe('params, delete and empty bodies', () => {
  it('id must be a uuid; no extra params', () => {
    expect(collectionIdParamsSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000' }).success).toBe(
      true,
    )
    expect(collectionIdParamsSchema.safeParse({ id: '1' }).success).toBe(false)
    expect(collectionIdParamsSchema.safeParse({ id: "' or 1=1 --" }).success).toBe(false)
  })

  it('delete requires confirmTitle (NFC + trim), and nothing else', () => {
    expect(parse(deleteCollectionSchema, { confirmTitle: '  é  ' })).toEqual({ confirmTitle: 'é' })
    for (const body of [
      undefined,
      {},
      { confirm: true },
      { confirmTitle: 1 },
      { confirmTitle: 'x'.repeat(1001) },
    ]) {
      const found = issues(deleteCollectionSchema, body)
      expect(found.length, JSON.stringify(body)).toBeGreaterThan(0)
    }
    expect(issues(deleteCollectionSchema, {})).toEqual([
      { path: 'confirmTitle', message: COLLECTION_MESSAGES.confirmMismatch },
    ])
  })

  it('archive body: none or {} only', () => {
    expect(emptyBodySchema.safeParse(undefined).success).toBe(true)
    expect(emptyBodySchema.safeParse({}).success).toBe(true)
    expect(emptyBodySchema.safeParse({ archivedAt: null }).success).toBe(false)
    expect(emptyBodySchema.safeParse(null).success).toBe(false)
  })
})

describe('DTO (U8)', () => {
  const row: CollectionRow = {
    id: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-000000000002',
    title: 'Animals',
    nativeLanguage: 'en',
    targetLanguage: 'fr',
    description: null,
    topic: 'zoo',
    archivedAt: new Date('2026-01-02T03:04:05.678Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    entryCount: 3,
  }

  it('collectionSchema has no ownerId or normalization', () => {
    expect(Object.keys(collectionSchema.shape)).not.toContain('ownerId')
    expect(Object.keys(collectionSchema.shape)).not.toContain('normalization')
  })

  it('toCollectionDto output parses strictly and drops ownerId', () => {
    const dto = toCollectionDto({ ...row, normalization: { x: 1 } } as CollectionRow)
    expect(collectionSchema.parse(dto)).toEqual(dto)
    expect(dto).not.toHaveProperty('ownerId')
    expect(dto).not.toHaveProperty('normalization')
    expect(dto.archivedAt).toBe('2026-01-02T03:04:05.678Z')
    expect(toCollectionDto({ ...row, archivedAt: null }).archivedAt).toBeNull()
    expect(collectionListSchema.parse({ items: [dto], nextCursor: null }).items).toHaveLength(1)
  })
})

describe('error mapping (U10)', () => {
  it('zodIssuesToPublic keeps every COLLECTION_MESSAGES text', () => {
    // Every message is whitelisted, so none is replaced by a generic code message.
    for (const message of Object.values(COLLECTION_MESSAGES)) {
      const result = createCollectionSchema.safeParse({})
      if (result.success) throw new Error('unreachable')
      const error = result.error
      error.issues.splice(0, error.issues.length, { code: 'custom', path: ['title'], message, input: '' })
      expect(zodIssuesToPublic(error)).toEqual([{ path: 'title', message }])
    }
  })

  it('never echoes the submitted value', () => {
    const result = createCollectionSchema.safeParse({
      ...valid,
      title: '<script>x</script>'.repeat(50),
      evil: 1,
    })
    if (result.success) throw new Error('unreachable')
    const text = JSON.stringify(zodIssuesToPublic(result.error))
    expect(text).not.toContain('script')
    expect(text).not.toContain('evil')
  })
})
