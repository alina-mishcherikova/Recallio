// U11 (ADR 0002 §6.6, D10): audit lines are one JSON object, with emails only as a keyed hash.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  audit,
  hashEmailForAudit,
  setAuditKey,
  setAuditWriter,
  type AuditFields,
} from '../../server/utils/audit'

const lines: string[] = []
const previous = setAuditWriter((line) => lines.push(line))
afterEach(() => {
  lines.length = 0
  setAuditKey(undefined)
})

const event = {
  method: 'POST',
  path: '/api/auth/login?x=1',
  context: { requestId: 'req-1', clientIp: '203.0.113.5' },
}

describe('audit()', () => {
  it('writes one line of JSON with the fixed fields', () => {
    setAuditKey(new Uint8Array(32).fill(1))
    audit(event, 'auth.login.failure', { email: 'Ana@Example.test', reason: 'unknown_user' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith('\n')).toBe(true)
    expect(lines[0]!.slice(0, -1)).not.toContain('\n')
    const record = JSON.parse(lines[0]!)
    expect(record).toEqual({
      ts: expect.any(String),
      level: 'warn',
      event: 'auth.login.failure',
      requestId: 'req-1',
      route: 'POST /api/auth/login',
      ip: '203.0.113.5',
      userId: null,
      emailHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      reason: 'unknown_user',
    })
    expect(lines[0]).not.toContain('Ana@Example.test')
    expect(lines[0]).not.toContain('ana@example.test')
  })

  it('hashes case-insensitively, and writes no hash before the key is loaded', () => {
    expect(hashEmailForAudit('a@b.cd')).toBeNull()
    setAuditKey(new Uint8Array(32).fill(2))
    expect(hashEmailForAudit('A@B.CD')).toBe(hashEmailForAudit('a@b.cd'))
    setAuditKey(new Uint8Array(32).fill(3))
    expect(hashEmailForAudit('a@b.cd')).not.toBe(null)
  })

  it('escapes control characters in the route (no log injection)', () => {
    audit({ ...event, path: '/api/x\n{"event":"forged"}' }, 'access.denied', { reason: 'unauthenticated' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1)
  })

  it('only accepts the declared fields (type-level)', () => {
    expectTypeOf<AuditFields>().not.toHaveProperty('password')
    expectTypeOf<AuditFields>().not.toHaveProperty('body')
    // @ts-expect-error -- unknown keys are a type error
    audit(event, 'auth.logout', { password: 'x' })
  })
})

process.on('exit', () => setAuditWriter(previous))
