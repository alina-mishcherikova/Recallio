// Counter storage for the auth rate limiters (ADR 0002 §5.4).
// Backed by an unstorage-like store (`useStorage('auth-limits')`, memory driver for now). Updates
// to one key are serialized in-process, so concurrent requests are never lost. LEX-017 swaps in a
// shared driver and must use atomic INCR/PEXPIRE there.
//
// Two key families with separate caps (LEX-003 security review, M2): backoff entries (per account,
// per user) and window entries (per IP). Nothing is ever evicted to make room: when a family is full,
// new keys of that family are refused (the limiter answers 429) until expired entries are pruned.
// So a flood of cheap per-IP keys can never erase a victim's backoff.

/** Every stored entry carries its own expiry, so an expired entry is treated as missing. */
export interface CounterEntry {
  expiresAt: number
}

/** The subset of unstorage's `Storage` we use. */
export interface StorageLike {
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  removeItem(key: string): Promise<void>
  getKeys(): Promise<string[]>
}

export type KeyFamily = 'backoff' | 'window'

/** Account and re-authentication backoff keys; everything else is a per-IP window key. */
export function keyFamily(key: string): KeyFamily {
  return key.startsWith('login-acct-') || key.startsWith('reauth-user-') ? 'backoff' : 'window'
}

/** Thrown by `update` when a new key would exceed its family's cap. */
export class CounterStoreFullError extends Error {
  constructor(readonly family: KeyFamily) {
    super(`auth limiter store is full (${family})`)
    this.name = 'CounterStoreFullError'
  }
}

export interface CounterStore {
  get<T extends CounterEntry>(key: string): Promise<T | undefined>
  /** Read-modify-write one key. Return `null` from `fn` to delete it. Throws CounterStoreFullError. */
  update<T extends CounterEntry>(key: string, fn: (current: T | undefined) => T | null): Promise<T | null>
  delete(key: string): Promise<void>
  /** Removes expired entries (never live ones). Returns the number removed. */
  prune(): Promise<number>
}

export const DEFAULT_MAX_KEYS: Readonly<Record<KeyFamily, number>> = Object.freeze({
  backoff: 50_000,
  window: 50_000,
})

/** Reclaiming expired keys when a family is full costs a scan: at most once per interval. */
const RECLAIM_INTERVAL_MS = 5_000

function isEntry(value: unknown): value is CounterEntry {
  return typeof value === 'object' && value !== null && typeof (value as CounterEntry).expiresAt === 'number'
}

export function createCounterStore(
  storage: StorageLike,
  opts: { now?: () => number; maxKeys?: number | Partial<Record<KeyFamily, number>> } = {},
): CounterStore {
  const now = opts.now ?? Date.now
  const caps: Record<KeyFamily, number> =
    typeof opts.maxKeys === 'number'
      ? { backoff: opts.maxKeys, window: opts.maxKeys }
      : { ...DEFAULT_MAX_KEYS, ...opts.maxKeys }
  // Keys this process has stored, per family. Rebuilt from storage on every prune.
  const index: Record<KeyFamily, Set<string>> = { backoff: new Set(), window: new Set() }
  const lastReclaim: Record<KeyFamily, number> = { backoff: -Infinity, window: -Infinity }
  const queues = new Map<string, Promise<unknown>>()

  const read = async <T extends CounterEntry>(key: string): Promise<T | undefined> => {
    const value = await storage.getItem(key)
    if (!isEntry(value) || value.expiresAt <= now()) return undefined
    return value as T
  }

  /** Serializes work per key; the queue entry is dropped once idle. */
  const serialized = <R>(key: string, work: () => Promise<R>): Promise<R> => {
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, settled)
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return next
  }

  const reclaim = async (family: KeyFamily) => {
    if (now() - lastReclaim[family] < RECLAIM_INTERVAL_MS) return
    lastReclaim[family] = now()
    for (const key of [...index[family]]) {
      const value = await storage.getItem(key)
      if (!isEntry(value) || value.expiresAt <= now()) {
        await storage.removeItem(key)
        index[family].delete(key)
      }
    }
  }

  return {
    get: read,
    update<T extends CounterEntry>(key: string, fn: (current: T | undefined) => T | null) {
      return serialized(key, async () => {
        const family = keyFamily(key)
        const current = await read<T>(key)
        if (current === undefined && !index[family].has(key) && index[family].size >= caps[family]) {
          await reclaim(family)
          if (index[family].size >= caps[family]) throw new CounterStoreFullError(family)
        }
        const next = fn(current)
        if (next === null) {
          await storage.removeItem(key)
          index[family].delete(key)
        } else {
          await storage.setItem(key, next)
          index[family].add(key)
        }
        return next
      })
    },
    delete(key) {
      return serialized(key, async () => {
        await storage.removeItem(key)
        index[keyFamily(key)].delete(key)
      })
    },
    async prune() {
      // The index is updated in place (never cleared): updates interleave at every await.
      let removed = 0
      for (const key of await storage.getKeys()) {
        const value = await storage.getItem(key)
        if (!isEntry(value) || value.expiresAt <= now()) {
          await storage.removeItem(key)
          index[keyFamily(key)].delete(key)
          removed++
        } else {
          index[keyFamily(key)].add(key)
        }
      }
      return removed
    },
  }
}
