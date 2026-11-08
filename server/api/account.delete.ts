// DELETE /api/account (session). ADR 0002 §2.2, §5.5; spec §15 Privacy. Current password required,
// then a hard delete through the cascades. 403 (not 401) on a wrong password: the user is still signed in.
import { sendNoContent } from 'h3'
import { AUTH_MESSAGES, deleteAccountRequestSchema } from '../../shared/schemas/auth'
import { deleteAccount } from '../services/auth/auth.service'
import { endSession } from '../services/auth/session'
import { requireAuth } from '../utils/auth'
import { readJsonBody } from '../utils/body'
import { parseOrBadRequest, publicError } from '../utils/errors'
import { authDeps, rateLimited } from '../utils/http-auth'

export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  const input = parseOrBadRequest(deleteAccountRequestSchema, await readJsonBody(event))
  const result = await deleteAccount(await authDeps(event), userId, input)
  if (!result.ok) {
    if (result.kind === 'rate_limited') rateLimited(event, result.retryAfter)
    if (result.kind === 'user_missing') {
      await endSession(event)
      throw publicError(401)
    }
    throw publicError(403, AUTH_MESSAGES.wrongPassword)
  }
  await endSession(event)
  return sendNoContent(event, 204)
})
