// Collection DTO (ADR 0003 §2.2). Built field by field, never by spreading a row: `ownerId` and
// `normalization` never leave the server.
import type { LanguageCode } from '../../../shared/constants/languages'
import type { Collection } from '../../../shared/schemas/collections'

/** Internal row: includes `ownerId` so the handler can call `requireOwner()`. Never returned as is. */
export interface CollectionRow {
  id: string
  ownerId: string
  title: string
  nativeLanguage: string
  targetLanguage: string
  description: string | null
  topic: string | null
  archivedAt: Date | null
  createdAt: Date
  entryCount: number
}

export function toCollectionDto(row: CollectionRow): Collection {
  return {
    id: row.id,
    title: row.title,
    nativeLanguage: row.nativeLanguage as LanguageCode,
    targetLanguage: row.targetLanguage as LanguageCode,
    description: row.description,
    topic: row.topic,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    entryCount: row.entryCount,
  }
}
