// POST /api/auth/register (public). ADR 0002 §2.2, §5.5, D4.
import { setResponseStatus } from 'h3'
import { AUTH_MESSAGES, registerRequestSchema, type AuthUserResponse } from '../../../shared/schemas/auth'
import { useDb } from '../../db/client'
import { register } from '../../services/auth/auth.service'
import { startSession } from '../../services/auth/session'
import { audit } from '../../utils/audit'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest, publicError } from '../../utils/errors'
import { authDeps, rateLimited } from '../../utils/http-auth'

export default defineEventHandler(async (event): Promise<AuthUserResponse> => {
  const input = parseOrBadRequest(registerRequestSchema, await readJsonBody(event), () =>
    audit(event, 'auth.register.failure', { reason: 'validation' }),
  )
  const result = await register(await authDeps(event), input)
  if (!result.ok) {
    if (result.kind === 'rate_limited') rateLimited(event, result.retryAfter)
    if (result.kind === 'duplicate_email') throw publicError(409, AUTH_MESSAGES.emailTaken)
    throw publicError(
      400,
      undefined,
      result.issues.map((issue) => ({ path: 'password', message: issue.message })),
    )
  }
  await startSession(event, useDb(), result.user.id)
  setResponseStatus(event, 201)
  return { user: result.user }
})
