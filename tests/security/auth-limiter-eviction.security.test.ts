// LEX-003 security review: the auth limiter store must not let an attacker erase a victim's
// backoff by flooding cheap keys (ADR 0002 §5.4, §11.5; OWASP A07).
//
// Black-box reproduction (built server, one process): put an account into a 15-minute backoff, send
// ~130,000 registrations with a blocklisted password from rotating IPv6 addresses (each creates a
// `register-ip-*` key before any scrypt, ~13,000 req/s locally), wait for the 1-minute prune, and the
// next guess on the victim account is evaluated (401) instead of refused (429). The prune evicts the
// oldest keys first, and the backoff entry is older than the flood.
//
// Expected fix: eviction never removes `login-acct-*` / `reauth-user-*` backoff entries before
// window entries (or caps each key family separately), and per-IP keys use the IPv6 /64.
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import { createCounterStore } from '../../server/services/auth/counter-store'
import { accountKey, createAuthRateLimiter, limitKeys } from '../../server/services/auth/rate-limit'

function setup(maxKeys: number) {
  let t = 1_800_000_000_000
  const now = () => t
  const store = createCounterStore(createStorage(), { now, maxKeys })
  return { store, limiter: createAuthRateLimiter(store, now), advance: (ms: number) => (t += ms) }
}

describe('limiter eviction', () => {
  it('an account in backoff stays in backoff after a flood of register-ip keys and a prune', async () => {
    const { store, limiter } = setup(100)
    const victim = accountKey(new Uint8Array(32).fill(7), 'victim@example.test')
    for (let i = 0; i < 12; i++) await limiter.recordBackoffFailure(victim)
    expect((await limiter.checkBackoff(victim)).ok).toBe(false)

    // The attacker's cheap keys: one register attempt per rotating IPv6 address.
    for (let i = 0; i < 500; i++) {
      await limiter.consumeWindow(limitKeys.registerIp(`2001:db8:e::${i.toString(16)}`), {
        max: 10,
        windowMs: 3_600_000,
      })
    }
    await store.prune()

    expect((await limiter.checkBackoff(victim)).ok, 'backoff entry was evicted by the flood').toBe(false)
  })

  it('per-IP keys for addresses in the same IPv6 /64 share one bucket', () => {
    expect(limitKeys.loginIp('2001:db8:1:2::1')).toBe(limitKeys.loginIp('2001:db8:1:2:ffff:ffff:ffff:fffe'))
    expect(limitKeys.registerIp('2001:db8:1:2::1')).toBe(limitKeys.registerIp('2001:db8:1:2::abcd'))
    // IPv4 stays per address.
    expect(limitKeys.loginIp('203.0.113.1')).not.toBe(limitKeys.loginIp('203.0.113.2'))
  })
})
