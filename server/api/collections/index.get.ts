// GET /api/collections (session). ADR 0003 §2.3. Owner-scoped keyset page.
import { getQuery } from 'h3'
import {
  COLLECTION_MESSAGES,
  listCollectionsQuerySchema,
  type CollectionList,
} from '../../../shared/schemas/collections'
import { useDb } from '../../db/client'
import { listCollections } from '../../services/collections/collections.service'
import { toCollectionDto } from '../../services/collections/dto'
import { requireAuth } from '../../utils/auth'
import { requireOwner } from '../../utils/authz'
import { parseOrBadRequest, publicError } from '../../utils/errors'

export default defineEventHandler(async (event): Promise<CollectionList> => {
  const { userId } = requireAuth(event)
  const query = parseOrBadRequest(listCollectionsQuerySchema, getQuery(event))
  const result = await listCollections(useDb(), userId, query)
  if (!result.ok) {
    throw publicError(400, undefined, [{ path: 'cursor', message: COLLECTION_MESSAGES.invalidCursor }])
  }
  return {
    // The query is owner-scoped; requireOwner is a second check that no foreign row ever leaves.
    items: result.items.map((row) => toCollectionDto(requireOwner(event, row, 'collection'))),
    nextCursor: result.nextCursor,
  }
})
