// GET /api/collections/:id (session). ADR 0003 §2.3. Missing or foreign → 404.
import { getQuery, getRouterParams } from 'h3'
import {
  collectionIdParamsSchema,
  emptyQuerySchema,
  type Collection,
} from '../../../shared/schemas/collections'
import { useDb } from '../../db/client'
import { getCollection } from '../../services/collections/collections.service'
import { toCollectionDto } from '../../services/collections/dto'
import { requireAuth } from '../../utils/auth'
import { requireOwner } from '../../utils/authz'
import { parseOrBadRequest } from '../../utils/errors'

export default defineEventHandler(async (event): Promise<Collection> => {
  const { userId } = requireAuth(event)
  const { id } = parseOrBadRequest(collectionIdParamsSchema, getRouterParams(event))
  parseOrBadRequest(emptyQuerySchema, getQuery(event))
  const row = requireOwner(event, await getCollection(useDb(), userId, id), 'collection')
  return toCollectionDto(row)
})
