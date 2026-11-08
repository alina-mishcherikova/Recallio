// Process-wide limiter on `useStorage('auth-limits')` (memory driver; nuxt.config.ts nitro.storage).
import { createCounterStore, type CounterStore } from './counter-store'
import { createAuthRateLimiter, type AuthRateLimiter } from './rate-limit'

let store: CounterStore | undefined
let limiter: AuthRateLimiter | undefined

function useCounterStore(): CounterStore {
  store ??= createCounterStore(useStorage('auth-limits'))
  return store
}

export function useAuthLimiter(): AuthRateLimiter {
  limiter ??= createAuthRateLimiter(useCounterStore())
  return limiter
}

/** Drops expired counters and caps the store at 100,000 keys (oldest first). */
export function pruneAuthLimits(): Promise<number> {
  return useCounterStore().prune()
}
