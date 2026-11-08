import { sql } from 'drizzle-orm'
import { useDb } from '../../db/client'

// Public readiness probe (on the public allow-list, docs/architecture.md §8), for GET and HEAD.
// The h3 router does not fall back from HEAD to GET, so both route files export this handler.
// Returns no version, hostnames, or error details (OWASP A02/A10). The DB result is cached for 5 s
// so unauthenticated traffic can't turn this route into a DB load generator (OWASP A06).
const CACHE_MS = 5_000
let cached: { ok: boolean; at: number } | undefined

export const healthHandler = defineEventHandler(async (event) => {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const ok = await useDb()
      .execute(sql`select 1`)
      .then(
        () => true,
        () => false,
      )
    cached = { ok, at: Date.now() }
  }
  setResponseHeader(event, 'cache-control', 'no-store')
  if (!cached.ok) {
    setResponseStatus(event, 503)
    return { status: 'degraded', database: 'unavailable' }
  }
  return { status: 'ok', database: 'ok' }
})
