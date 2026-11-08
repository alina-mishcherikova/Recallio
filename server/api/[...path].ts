// Catch-all for unknown /api/** routes (ADR 0002 §6.2 item 5). Anonymous callers already got 401
// from server/handlers/02.auth.ts; signed-in callers get a JSON 404 here instead of falling through
// to the page renderer. Specific routes always win over this wildcard in the router.
import { requireAuth } from '../utils/auth'
import { publicError } from '../utils/errors'

export default defineEventHandler((event) => {
  requireAuth(event)
  throw publicError(404)
})
