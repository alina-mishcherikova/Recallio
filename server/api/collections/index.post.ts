// POST /api/collections (session). ADR 0003 §2.3, D3. `owner_id` is always the session user.
import { setResponseStatus } from 'h3'
import {
  COLLECTION_MESSAGES,
  createCollectionSchema,
  type Collection,
} from '../../../shared/schemas/collections'
import { useDb } from '../../db/client'
import { createCollection } from '../../services/collections/collections.service'
import { toCollectionDto } from '../../services/collections/dto'
import { requireAuth } from '../../utils/auth'
import { requireOwner } from '../../utils/authz'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest, publicError } from '../../utils/errors'

export default defineEventHandler(async (event): Promise<Collection> => {
  const { userId } = requireAuth(event)
  const input = parseOrBadRequest(createCollectionSchema, await readJsonBody(event))
  const result = await createCollection(useDb(), userId, input)
  if (!result.ok) {
    if (result.kind === 'limit_reached') throw publicError(409, COLLECTION_MESSAGES.limitReached)
    throw publicError(401) // the user was deleted between the session check and now
  }
  const row = requireOwner(event, result.row, 'collection')
  setResponseStatus(event, 201)
  return toCollectionDto(row)
})
