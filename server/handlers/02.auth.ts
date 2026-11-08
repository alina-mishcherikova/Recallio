// Deny by default (ADR 0002 §6.2; architecture §8 A01). Resolves the session cookie against
// user_sessions and sets event.context.auth, the only identity source. Every /api/** route that is
// not on the exact allow-list answers 401 without a valid session, including unknown routes.
import type { H3Event } from 'h3'
import { useDb } from '../db/client'
import { loadAuthKeys } from '../services/auth/keys'
import { endSession, readPresentedSession } from '../services/auth/session'
import { checkSession } from '../services/auth/session-store'
import { audit } from '../utils/audit'
import { publicError } from '../utils/errors'
import { isApiPath, isBlockedModuleSessionRoute, isPublicApiRoute } from '../utils/public-routes'

export default defineEventHandler(async (event: H3Event) => {
  if (!isApiPath(event.path)) return // pages and assets get their data from /api
  const pathname = event.path.split('?', 1)[0]!

  // Logout has one path (POST /api/auth/logout), which revokes the row and writes the audit log.
  // Matched on the normalized path: `/api/_auth/session/`, `//`, `?x=1` all reach the module route.
  if (isBlockedModuleSessionRoute(event.method, event.path)) throw publicError(404)

  try {
    await loadAuthKeys() // audit email hashing; the dummy hash and blocklist are awaited where used
  } catch {
    throw publicError(503)
  }

  event.context.auth = undefined
  const presented = await readPresentedSession(event)
  if (presented.kind === 'malformed') {
    await endSession(event)
    audit(event, 'auth.session.invalid', { reason: 'malformed' })
  } else if (presented.kind === 'present') {
    let check
    try {
      check = await checkSession(useDb(), presented)
    } catch {
      throw publicError(503) // fail closed: never anonymous access because the DB is down
    }
    if (check.ok) {
      event.context.auth = { userId: presented.userId, sessionId: presented.sid }
    } else {
      await endSession(event)
      audit(event, 'auth.session.invalid', { reason: check.reason })
    }
  }

  // The module route would answer `{ id }` for a cleared session; anonymous callers get exactly `{}`.
  if (
    !event.context.auth &&
    (event.method === 'GET' || event.method === 'HEAD') &&
    pathname === '/api/_auth/session'
  ) {
    return {}
  }

  if (!event.context.auth && !isPublicApiRoute(event.method, event.path)) {
    audit(event, 'access.denied', { reason: 'unauthenticated' })
    throw publicError(401)
  }
})
