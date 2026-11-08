// POST /api/auth/login (public). ADR 0002 §2.2, §5.5. Same 401 for an unknown email and a wrong password.
import { AUTH_MESSAGES, loginRequestSchema, type AuthUserResponse } from '../../../shared/schemas/auth'
import { useDb } from '../../db/client'
import { login } from '../../services/auth/auth.service'
import { startSession } from '../../services/auth/session'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest, publicError } from '../../utils/errors'
import { authDeps, rateLimited } from '../../utils/http-auth'

export default defineEventHandler(async (event): Promise<AuthUserResponse> => {
  const input = parseOrBadRequest(loginRequestSchema, await readJsonBody(event))
  const result = await login(await authDeps(event), input)
  if (!result.ok) {
    if (result.kind === 'rate_limited') rateLimited(event, result.retryAfter)
    throw publicError(401, AUTH_MESSAGES.invalidCredentials)
  }
  await startSession(event, useDb(), result.user.id)
  return { user: result.user }
})
