// GET /api/auth/me (session). ADR 0002 §2.2. The profile comes from the DB, never from the cookie.
import { getQuery } from 'h3'
import { z } from '../../../shared/zod'
import type { AuthUserResponse } from '../../../shared/schemas/auth'
import { useDb } from '../../db/client'
import { findPublicUserById } from '../../services/auth/users'
import { requireAuth } from '../../utils/auth'
import { parseOrBadRequest, publicError } from '../../utils/errors'

const meQuerySchema = z.object({}).strict()

export default defineEventHandler(async (event): Promise<AuthUserResponse> => {
  const { userId } = requireAuth(event)
  parseOrBadRequest(meQuerySchema, getQuery(event))
  const user = await findPublicUserById(useDb(), userId)
  if (!user) throw publicError(401) // deleted between the session check and now
  return { user }
})
