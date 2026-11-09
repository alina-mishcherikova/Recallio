// PATCH /api/collections/:id (session). ADR 0003 §2.3, D2. Archived → 409; RC002 → 409.
import { getQuery, getRouterParams } from 'h3'
import {
  COLLECTION_MESSAGES,
  collectionIdParamsSchema,
  emptyQuerySchema,
  updateCollectionSchema,
  type Collection,
} from '../../../shared/schemas/collections'
import { useDb } from '../../db/client'
import { updateCollection } from '../../services/collections/collections.service'
import { toCollectionDto } from '../../services/collections/dto'
import { requireAuth } from '../../utils/auth'
import { requireOwner } from '../../utils/authz'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest, publicError } from '../../utils/errors'

export default defineEventHandler(async (event): Promise<Collection> => {
  const { userId } = requireAuth(event)
  const { id } = parseOrBadRequest(collectionIdParamsSchema, getRouterParams(event))
  parseOrBadRequest(emptyQuerySchema, getQuery(event))
  const input = parseOrBadRequest(updateCollectionSchema, await readJsonBody(event))
  const result = await updateCollection(useDb(), userId, id, input)
  if (result.ok) return toCollectionDto(requireOwner(event, result.row, 'collection'))
  switch (result.kind) {
    case 'not_found':
      throw requireOwner(event, null, 'collection') // throws the 404 and audits access.denied
    case 'archived':
      throw publicError(409, COLLECTION_MESSAGES.archived)
    case 'languages_locked':
      throw publicError(409, COLLECTION_MESSAGES.languagesLocked)
    case 'languages_same':
      throw publicError(400, undefined, [
        { path: 'targetLanguage', message: COLLECTION_MESSAGES.languagesSame },
      ])
  }
})
