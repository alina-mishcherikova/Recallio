// Auth boot work (ADR 0002 §5.2–§5.4, §4.2): derive keys, compute the dummy hash and load the
// blocklist now rather than on the first login; prune limiter counters every minute; sweep expired
// and idle sessions every hour. Failures log a fixed message only (details may contain values).
import { useDb } from '../db/client'
import { ensureAuthReady } from '../services/auth/boot'
import { pruneAuthLimits } from '../services/auth/limiter'
import { sweepSessions } from '../services/auth/session-store'

const MINUTE = 60_000

export default defineNitroPlugin((nitroApp) => {
  ensureAuthReady().catch(() =>
    console.error('[auth] initialization failed; auth routes answer 503 until it succeeds'),
  )

  const prune = setInterval(() => {
    pruneAuthLimits().catch(() => console.error('[auth] rate-limit prune failed'))
  }, MINUTE)
  const sweep = setInterval(() => {
    sweepSessions(useDb()).catch(() => console.error('[auth] session sweep failed'))
  }, 60 * MINUTE)
  prune.unref()
  sweep.unref()

  nitroApp.hooks.hook('close', () => {
    clearInterval(prune)
    clearInterval(sweep)
  })
})
