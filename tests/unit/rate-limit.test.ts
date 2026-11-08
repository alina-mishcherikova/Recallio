// U9 (ADR 0002 §5.4): backoff, fixed windows, Retry-After, and the counter store.
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import { createCounterStore, keyFamily } from '../../server/services/auth/counter-store'
import {
  BACKOFF,
  LOGIN_IP_LIMIT,
  REGISTER_IP_LIMIT,
  STORE_FULL_RETRY_AFTER,
  accountKey,
  backoffDelayMs,
  createAuthRateLimiter,
  limitKeys,
  retryAfterSeconds,
} from '../../server/services/auth/rate-limit'

function setup() {
  let t = 1_800_000_000_000
  const clock = { now: () => t, advance: (ms: number) => (t += ms) }
  const store = createCounterStore(createStorage(), { now: clock.now })
  return { clock, store, limiter: createAuthRateLimiter(store, clock.now) }
}

describe('backoffDelayMs', () => {
  it('gives 5 free failures, then 15 s doubling to a 15-minute cap', () => {
    expect([0, 1, 2, 3, 4].map(backoffDelayMs)).toEqual([0, 0, 0, 0, 0])
    expect(backoffDelayMs(5)).toBe(15_000)
    expect(backoffDelayMs(6)).toBe(30_000)
    expect(backoffDelayMs(7)).toBe(60_000)
    expect(backoffDelayMs(10)).toBe(480_000)
    expect(backoffDelayMs(11)).toBe(900_000)
    expect(backoffDelayMs(12)).toBe(900_000)
    expect(backoffDelayMs(1e9)).toBe(900_000)
  })

  it('rounds Retry-After up to whole seconds, at least 1', () => {
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(0)).toBe(1)
    expect(retryAfterSeconds(14_001)).toBe(15)
    expect(retryAfterSeconds(15_000)).toBe(15)
  })
})

describe('account backoff', () => {
  it('blocks the 6th attempt for 15 s, then lets one through, then doubles', async () => {
    const { limiter, clock } = setup()
    const key = 'acct'
    for (let i = 0; i < BACKOFF.freeFailures; i++) {
      expect(await limiter.checkBackoff(key)).toEqual({ ok: true })
      await limiter.recordBackoffFailure(key)
    }
    expect(await limiter.checkBackoff(key)).toEqual({ ok: false, retryAfter: 15 })
    clock.advance(14_000)
    expect(await limiter.checkBackoff(key)).toEqual({ ok: false, retryAfter: 1 })
    clock.advance(1_000)
    expect(await limiter.checkBackoff(key)).toEqual({ ok: true })
    await limiter.recordBackoffFailure(key) // 6th failure → 30 s
    expect(await limiter.checkBackoff(key)).toEqual({ ok: false, retryAfter: 30 })
  })

  it('caps at 15 minutes and never locks out permanently', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < 40; i++) await limiter.recordBackoffFailure('k')
    expect(await limiter.checkBackoff('k')).toEqual({ ok: false, retryAfter: 900 })
    clock.advance(900_000)
    expect(await limiter.checkBackoff('k')).toEqual({ ok: true })
  })

  it('resets on success', async () => {
    const { limiter } = setup()
    for (let i = 0; i < 9; i++) await limiter.recordBackoffFailure('k')
    await limiter.resetBackoff('k')
    expect(await limiter.checkBackoff('k')).toEqual({ ok: true })
  })

  it('forgets failures 24 h after the last one', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < 9; i++) await limiter.recordBackoffFailure('k')
    clock.advance(BACKOFF.ttlMs - 1)
    await limiter.recordBackoffFailure('k') // the TTL restarts from the last failure
    clock.advance(BACKOFF.ttlMs - 1)
    expect(await limiter.checkBackoff('k')).toEqual({ ok: true }) // waited out, entry still present
    clock.advance(1)
    await limiter.recordBackoffFailure('k')
    expect(await limiter.checkBackoff('k')).toEqual({ ok: true }) // fresh count: 1 failure
  })

  it('counts concurrent failures without losing any', async () => {
    const { limiter } = setup()
    await Promise.all(Array.from({ length: 5 }, () => limiter.recordBackoffFailure('k')))
    expect((await limiter.checkBackoff('k')).ok).toBe(false)
  })
})

describe('fixed windows', () => {
  it('login: 20 failures per IP per 15 minutes; Retry-After = window end', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < LOGIN_IP_LIMIT.max; i++) {
      expect((await limiter.checkWindow('ip', LOGIN_IP_LIMIT)).ok).toBe(true)
      await limiter.hitWindow('ip', LOGIN_IP_LIMIT)
    }
    expect(await limiter.checkWindow('ip', LOGIN_IP_LIMIT)).toEqual({ ok: false, retryAfter: 900 })
    clock.advance(600_000)
    expect(await limiter.checkWindow('ip', LOGIN_IP_LIMIT)).toEqual({ ok: false, retryAfter: 300 })
    clock.advance(300_000)
    expect(await limiter.checkWindow('ip', LOGIN_IP_LIMIT)).toEqual({ ok: true })
  })

  it('register: consume counts every attempt, 10 per hour', async () => {
    const { limiter } = setup()
    const results = await Promise.all(
      Array.from({ length: 12 }, () => limiter.consumeWindow('r', REGISTER_IP_LIMIT)),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect(results.at(-1)).toEqual({ ok: false, retryAfter: 3600 })
  })
})

describe('keys', () => {
  it('never contain the email or raw separators', () => {
    const key = accountKey(new Uint8Array(32).fill(7), 'ana@example.test')
    expect(key).toMatch(/^login-acct-[0-9a-f]{64}$/)
    expect(key).not.toContain('ana')
    expect(limitKeys.loginIp('2001:db8::1')).not.toContain(':')
    expect(limitKeys.loginIp('2001:db8:0:1::1')).not.toBe(limitKeys.loginIp('2001:db8:0:2::1'))
    expect(limitKeys.loginIp('::ffff:203.0.113.9')).toBe(limitKeys.loginIp('203.0.113.9'))
  })
})

describe('reservations (security review H1)', () => {
  it('reserveBackoff books a pending failure: 15 parallel attempts → 5 pass', async () => {
    const { limiter } = setup()
    const results = await Promise.all(Array.from({ length: 15 }, () => limiter.reserveBackoff('k')))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.retryAfter === 15)).toBe(true)
  })

  it('a sequential failure sequence behaves like check-then-record', async () => {
    const { limiter, clock } = setup()
    for (let i = 0; i < 5; i++) expect((await limiter.reserveBackoff('k')).ok).toBe(true)
    expect(await limiter.reserveBackoff('k')).toEqual({ ok: false, retryAfter: 15 })
    clock.advance(15_000)
    expect((await limiter.reserveBackoff('k')).ok).toBe(true) // the 6th failure is booked
    expect(await limiter.checkBackoff('k')).toEqual({ ok: false, retryAfter: 30 })
    await limiter.resetBackoff('k') // a success clears it
    expect(await limiter.checkBackoff('k')).toEqual({ ok: true })
  })

  it('reserveWindow: 30 parallel → 20 pass; a refund gives one slot back', async () => {
    const { limiter } = setup()
    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.reserveWindow('ip', LOGIN_IP_LIMIT)),
    )
    const passed = results.filter((r) => r.ok)
    expect(passed).toHaveLength(20)
    expect((await limiter.reserveWindow('ip', LOGIN_IP_LIMIT)).ok).toBe(false)
    await (passed[0] as { refund: () => Promise<void> }).refund()
    expect((await limiter.reserveWindow('ip', LOGIN_IP_LIMIT)).ok).toBe(true)
  })

  it('a refund never lands in a later window', async () => {
    const { limiter, clock } = setup()
    const slot = await limiter.reserveWindow('ip', LOGIN_IP_LIMIT)
    clock.advance(LOGIN_IP_LIMIT.windowMs)
    for (let i = 0; i < 20; i++) await limiter.hitWindow('ip', LOGIN_IP_LIMIT)
    await (slot as { refund: () => Promise<void> }).refund()
    expect((await limiter.checkWindow('ip', LOGIN_IP_LIMIT)).ok).toBe(false)
  })
})

describe('counter store (security review M2)', () => {
  it('treats expired entries as missing; prune removes only expired entries', async () => {
    let t = 0
    const storage = createStorage()
    const store = createCounterStore(storage, { now: () => t, maxKeys: 10 })
    await store.update('login-ip-a', () => ({ expiresAt: 10 }))
    await store.update('login-ip-b', () => ({ expiresAt: 100 }))
    await store.update('login-acct-c', () => ({ expiresAt: 100 }))
    t = 50
    expect(await store.get('login-ip-a')).toBeUndefined()
    expect(await store.prune()).toBe(1)
    expect((await storage.getKeys()).sort()).toEqual(['login-acct-c', 'login-ip-b'])
  })

  it('refuses new keys when a family is full (429), never evicting, and keeps families apart', async () => {
    const { store, limiter } = (() => {
      const t = 1_800_000_000_000
      const s = createCounterStore(createStorage(), { now: () => t, maxKeys: { window: 2, backoff: 2 } })
      return { store: s, limiter: createAuthRateLimiter(s, () => t) }
    })()
    expect((await limiter.consumeWindow(limitKeys.registerIp('198.51.100.1'), REGISTER_IP_LIMIT)).ok).toBe(
      true,
    )
    expect((await limiter.consumeWindow(limitKeys.registerIp('198.51.100.2'), REGISTER_IP_LIMIT)).ok).toBe(
      true,
    )
    expect(await limiter.consumeWindow(limitKeys.registerIp('198.51.100.3'), REGISTER_IP_LIMIT)).toEqual({
      ok: false,
      retryAfter: STORE_FULL_RETRY_AFTER,
    })
    expect((await limiter.reserveWindow(limitKeys.loginIp('198.51.100.4'), LOGIN_IP_LIMIT)).ok).toBe(false)
    // Existing keys keep working, and the backoff family has its own room.
    expect((await limiter.consumeWindow(limitKeys.registerIp('198.51.100.1'), REGISTER_IP_LIMIT)).ok).toBe(
      true,
    )
    expect((await limiter.reserveBackoff('login-acct-x')).ok).toBe(true)
    expect(await store.prune()).toBe(0)
  })

  it('classifies key families', () => {
    expect(keyFamily('login-acct-abc')).toBe('backoff')
    expect(keyFamily('reauth-user-abc')).toBe('backoff')
    expect(keyFamily('login-ip-abc')).toBe('window')
    expect(keyFamily('register-ip-abc')).toBe('window')
  })
})
