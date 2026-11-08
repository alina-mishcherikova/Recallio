import { sql } from 'drizzle-orm'
import { useDb } from '../db/client'

// Public liveness/readiness probe. Returns no version, hostnames, or error details (OWASP A02/A10).
export default defineEventHandler(async (event) => {
  try {
    await useDb().execute(sql`select 1`)
    return { status: 'ok', database: 'ok' }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'degraded', database: 'unavailable' }
  }
})
