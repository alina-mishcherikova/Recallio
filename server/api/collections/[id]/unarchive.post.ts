// POST /api/collections/:id/unarchive (session). ADR 0003 §2.3, D2. Idempotent; never touches srs_cards.
import { getQuery, getRouterParams } from 'h3'
import {
  collectionIdParamsSchema,
  emptyBodySchema,
  emptyQuerySchema,
  type Collection,
} from '../../../../shared/schemas/collections'
import { useDb } from '../../../db/client'
import { setArchived } from '../../../services/collections/collections.service'
import { toCollectionDto } from '../../../services/collections/dto'
import { requireAuth } from '../../../utils/auth'
import { requireOwner } from '../../../utils/authz'
import { readJsonBody } from '../../../utils/body'
import { parseOrBadRequest } from '../../../utils/errors'

export default defineEventHandler(async (event): Promise<Collection> => {
  const { userId } = requireAuth(event)
  const { id } = parseOrBadRequest(collectionIdParamsSchema, getRouterParams(event))
  parseOrBadRequest(emptyQuerySchema, getQuery(event))
  parseOrBadRequest(emptyBodySchema, await readJsonBody(event))
  const row = requireOwner(event, await setArchived(useDb(), userId, id, false), 'collection')
  return toCollectionDto(row)
})
