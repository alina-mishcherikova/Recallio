// requireAuth / requireOwner (ADR 0002 §2.4; rule 5): a foreign or missing row is a 404, never 403.
// This is the IDOR fixture until LEX-004 adds the first owned route (the api tests add expectIdor).
import { afterAll, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { setAuditWriter } from '../../server/utils/audit'
import { requireAuth } from '../../server/utils/auth'
import { requireOwner } from '../../server/utils/authz'
import { toPublicErrorBody } from '../../server/utils/errors'

const lines: string[] = []
const previous = setAuditWriter((line) => lines.push(line))
afterAll(() => setAuditWriter(previous))

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const eventAs = (userId?: string) =>
  ({
    method: 'GET',
    path: '/api/collections/x',
    context: {
      requestId: 'r',
      clientIp: '198.51.100.1',
      ...(userId && { auth: { userId, sessionId: 's' } }),
    },
  }) as unknown as H3Event

function statusOf(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    return toPublicErrorBody(error)
  }
  throw new Error('expected an error')
}

describe('requireAuth', () => {
  it('returns the context identity', () => {
    expect(requireAuth(eventAs(alice))).toEqual({ userId: alice, sessionId: 's' })
  })

  it('throws 401 without a session', () => {
    expect(statusOf(() => requireAuth(eventAs()))).toEqual({ statusCode: 401, message: 'Unauthorized' })
  })
})

describe('requireOwner', () => {
  it('returns an owned row (ownerId or userId)', () => {
    const row = { id: 'c1', ownerId: alice }
    expect(requireOwner(eventAs(alice), row, 'collection')).toBe(row)
    const card = { id: 'k1', userId: alice }
    expect(requireOwner(eventAs(alice), card, 'card')).toBe(card)
  })

  it.each([
    ['foreign row', { id: 'c1', ownerId: bob }],
    ['missing row', null],
    ['undefined', undefined],
  ])('%s → 404 Not Found and an access.denied audit line', (_label, row) => {
    lines.length = 0
    expect(statusOf(() => requireOwner(eventAs(alice), row, 'collection'))).toEqual({
      statusCode: 404,
      message: 'Not Found',
    })
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      event: 'access.denied',
      reason: 'not_owner',
      resource: 'collection',
      userId: alice,
    })
  })

  it('needs a session first (401, not 404)', () => {
    expect(statusOf(() => requireOwner(eventAs(), { ownerId: alice }, 'collection')).statusCode).toBe(401)
  })
})
