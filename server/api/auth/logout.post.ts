// POST /api/auth/logout (session). ADR 0002 §2.2, §4.2. Deletes the session row(s), then the cookie.
import { sendNoContent } from 'h3'
import { logoutRequestSchema } from '../../../shared/schemas/auth'
import { useDb } from '../../db/client'
import { logout } from '../../services/auth/auth.service'
import { endSession } from '../../services/auth/session'
import { auditSink } from '../../utils/audit'
import { requireAuth } from '../../utils/auth'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest } from '../../utils/errors'

export default defineEventHandler(async (event) => {
  const auth = requireAuth(event)
  const input = parseOrBadRequest(logoutRequestSchema, await readJsonBody(event))
  await logout({ db: useDb(), audit: auditSink(event) }, auth, input)
  await endSession(event)
  return sendNoContent(event, 204)
})
