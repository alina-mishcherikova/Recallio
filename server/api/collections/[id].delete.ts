// DELETE /api/collections/:id (session). ADR 0003 §2.3, D1. Hard delete after the typed-title
// confirmation; the cascades remove entries, cards, logs and attempts. Audited without the title.
import { getQuery, getRouterParams, sendNoContent } from 'h3'
import {
  COLLECTION_MESSAGES,
  collectionIdParamsSchema,
  deleteCollectionSchema,
  emptyQuerySchema,
} from '../../../shared/schemas/collections'
import { useDb } from '../../db/client'
import { deleteCollection } from '../../services/collections/collections.service'
import { audit } from '../../utils/audit'
import { requireAuth } from '../../utils/auth'
import { requireOwner } from '../../utils/authz'
import { readJsonBody } from '../../utils/body'
import { parseOrBadRequest, publicError } from '../../utils/errors'

export default defineEventHandler(async (event) => {
  const { userId } = requireAuth(event)
  const { id } = parseOrBadRequest(collectionIdParamsSchema, getRouterParams(event))
  parseOrBadRequest(emptyQuerySchema, getQuery(event))
  const { confirmTitle } = parseOrBadRequest(deleteCollectionSchema, await readJsonBody(event))
  const result = await deleteCollection(useDb(), userId, id, confirmTitle)
  // Ownership first: a foreign or missing id is a 404 whatever the title.
  requireOwner(event, result.ok || result.kind === 'mismatch' ? result.row : null, 'collection')
  if (!result.ok) {
    throw publicError(400, undefined, [
      { path: 'confirmTitle', message: COLLECTION_MESSAGES.confirmMismatch },
    ])
  }
  audit(event, 'collection.deleted', { resource: 'collection' })
  return sendNoContent(event, 204)
})
