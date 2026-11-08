// Auth rate limiting and backoff (ADR 0002 §5.4; OWASP A07, NIST 800-63B §5.2.2).
// Limits are checked before the user lookup and the hash, so a blocked attempt costs no scrypt.
// Account keys exist whether or not the email is registered, so backoff never reveals existence.
// No permanent lockout: without password reset, a lockout would let anyone lock a user out for good.
import { createHmac } from 'node:crypto'
import { rateLimitSubject } from '../../utils/client-ip'
import { CounterStoreFullError, type CounterEntry, type CounterStore } from './counter-store'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export interface WindowLimit {
  max: number
  windowMs: number
}

export const LOGIN_IP_LIMIT: WindowLimit = { max: 20, windowMs: 15 * MINUTE }
export const REGISTER_IP_LIMIT: WindowLimit = { max: 10, windowMs: HOUR }

export const BACKOFF = Object.freeze({
  freeFailures: 5,
  baseMs: 15 * SECOND,
  capMs: 15 * MINUTE,
  ttlMs: 24 * HOUR,
})

/** Wait required after the last failure: 0 for the free attempts, then 15 s, 30 s, 1 min, … 15 min. */
export function backoffDelayMs(failures: number): number {
  if (failures < BACKOFF.freeFailures) return 0
  const exponent = failures - BACKOFF.freeFailures
  // 2^exponent overflows to Infinity for huge counts; Math.min caps it.
  return Math.min(BACKOFF.baseMs * 2 ** Math.min(exponent, 30), BACKOFF.capMs)
}

/** `Retry-After` in whole seconds, rounded up, at least 1. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / SECOND))
}

export type LimitResult = { ok: true } | { ok: false; retryAfter: number }

interface WindowEntry extends CounterEntry {
  count: number
  resetAt: number
}

interface BackoffEntry extends CounterEntry {
  failures: number
  lastFailureAt: number
}

/** Never put an email in a key: `acct:` keys use HMAC-SHA256(deriveSecret('recallio:rate-limit'), email). */
export function accountKey(hmacKey: Uint8Array, normalizedEmail: string): string {
  return `login-acct-${createHmac('sha256', hmacKey).update(normalizedEmail).digest('hex')}`
}

/**
 * Per-IP keys count the rate-limit subject: the IPv4 address, or the IPv6 /64 (security review M1).
 * The subject contains `:`, which storage drivers treat as a separator: encode it.
 */
const encodeIp = (ip: string) => Buffer.from(rateLimitSubject(ip), 'utf8').toString('base64url')

export const limitKeys = {
  loginIp: (ip: string) => `login-ip-${encodeIp(ip)}`,
  registerIp: (ip: string) => `register-ip-${encodeIp(ip)}`,
  reauthUser: (userId: string) => `reauth-user-${userId}`,
}

/** Retry-After when the store refuses a new key: roughly the next prune (once a minute). */
export const STORE_FULL_RETRY_AFTER = 60

/** A booked attempt in a fixed window. `refund()` gives it back (for example after a success). */
export type WindowReservation = { ok: true; refund: () => Promise<void> } | { ok: false; retryAfter: number }

export interface AuthRateLimiter {
  /** Fixed window: is the limit already reached? Does not count. */
  checkWindow(key: string, limit: WindowLimit): Promise<LimitResult>
  /** Fixed window: count one event. */
  hitWindow(key: string, limit: WindowLimit): Promise<void>
  /** Fixed window: check and count in one serialized step (registration counts every attempt). */
  consumeWindow(key: string, limit: WindowLimit): Promise<LimitResult>
  /** Like consumeWindow, but the booked attempt can be refunded (login counts failures only). */
  reserveWindow(key: string, limit: WindowLimit): Promise<WindowReservation>
  /** Backoff: must the caller still wait after the last failure? Does not count. */
  checkBackoff(key: string): Promise<LimitResult>
  /**
   * Backoff: check and book a pending failure (failures + 1, lastFailureAt = now) in one serialized
   * step, BEFORE the password is checked. Parallel guesses therefore see each other's failures
   * (security review H1). Call `resetBackoff` on success.
   */
  reserveBackoff(key: string): Promise<LimitResult>
  recordBackoffFailure(key: string): Promise<void>
  resetBackoff(key: string): Promise<void>
}

export function createAuthRateLimiter(store: CounterStore, now: () => number = Date.now): AuthRateLimiter {
  const blockedWindow = (entry: WindowEntry | undefined, limit: WindowLimit): LimitResult => {
    const t = now()
    if (!entry || entry.resetAt <= t || entry.count < limit.max) return { ok: true }
    return { ok: false, retryAfter: retryAfterSeconds(entry.resetAt - t) }
  }

  const increment = (entry: WindowEntry | undefined, limit: WindowLimit): WindowEntry => {
    const t = now()
    if (!entry || entry.resetAt <= t) {
      return { count: 1, resetAt: t + limit.windowMs, expiresAt: t + limit.windowMs }
    }
    return { ...entry, count: entry.count + 1 }
  }

  const blockedBackoff = (entry: BackoffEntry | undefined): LimitResult => {
    if (!entry) return { ok: true }
    const waitUntil = entry.lastFailureAt + backoffDelayMs(entry.failures)
    const t = now()
    return waitUntil <= t ? { ok: true } : { ok: false, retryAfter: retryAfterSeconds(waitUntil - t) }
  }

  const addFailure = (entry: BackoffEntry | undefined): BackoffEntry => {
    const t = now()
    return { failures: (entry?.failures ?? 0) + 1, lastFailureAt: t, expiresAt: t + BACKOFF.ttlMs }
  }

  /** A full store refuses new keys: fail closed with 429, never evict (security review M2). */
  const full: LimitResult = { ok: false, retryAfter: STORE_FULL_RETRY_AFTER }
  async function orFull<R>(work: () => Promise<R>, onFull: R): Promise<R> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof CounterStoreFullError) return onFull
      throw error
    }
  }

  async function bookWindow(key: string, limit: WindowLimit): Promise<WindowEntry | LimitResult> {
    let result: LimitResult = { ok: true }
    const entry = await store.update<WindowEntry>(key, (current) => {
      result = blockedWindow(current, limit)
      return result.ok ? increment(current, limit) : (current ?? null)
    })
    return result.ok ? entry! : result
  }

  return {
    async checkWindow(key, limit) {
      return blockedWindow(await store.get<WindowEntry>(key), limit)
    },
    async hitWindow(key, limit) {
      await orFull(() => store.update<WindowEntry>(key, (entry) => increment(entry, limit)), null)
    },
    async consumeWindow(key, limit) {
      return orFull<LimitResult>(async () => {
        const booked = await bookWindow(key, limit)
        return 'ok' in booked ? booked : { ok: true as const }
      }, full)
    },
    async reserveWindow(key, limit) {
      return orFull<WindowReservation>(async () => {
        const booked = await bookWindow(key, limit)
        if ('ok' in booked) return booked as WindowReservation
        const { resetAt } = booked
        return {
          ok: true,
          refund: async () => {
            await store.update<WindowEntry>(key, (current) => {
              if (!current) return null
              // Only refund into the window the attempt was booked in.
              return current.resetAt === resetAt
                ? { ...current, count: Math.max(0, current.count - 1) }
                : current
            })
          },
        }
      }, full as WindowReservation)
    },
    async checkBackoff(key) {
      return blockedBackoff(await store.get<BackoffEntry>(key))
    },
    async reserveBackoff(key) {
      return orFull<LimitResult>(async () => {
        let result: LimitResult = { ok: true }
        await store.update<BackoffEntry>(key, (current) => {
          result = blockedBackoff(current)
          return result.ok ? addFailure(current) : (current ?? null)
        })
        return result
      }, full)
    },
    async recordBackoffFailure(key) {
      await orFull(() => store.update<BackoffEntry>(key, addFailure), null)
    },
    async resetBackoff(key) {
      await store.delete(key)
    },
  }
}
