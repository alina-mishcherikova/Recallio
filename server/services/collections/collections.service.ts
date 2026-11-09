// Collections (ADR 0003 §3). Every statement is scoped to `owner_id = userId`: another user's
// collection and a missing one look identical (null / not_found), and the handler turns both into a
// 404 through requireOwner(). No imports from db/schema/srs: the only effect on srs_* is the FK
// cascade on hard delete (ADR 0001 X2). No `event` here (layering): handlers pass `useDb()`.
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { collections, users, vocabularyEntries } from '../../db/schema'
import {
  COLLECTION_LIMIT,
  type CreateCollectionInput,
  type ListCollectionsQuery,
  type UpdateCollectionInput,
} from '../../../shared/schemas/collections'
import { pgErrorInfo } from '../../utils/errors'
import type { CollectionRow } from './dto'

/**
 * Correlated count on the `(collection_id, created_at, id)` index. Cheap for ≤ 50 rows per page.
 * The outer column is written qualified on purpose: Drizzle renders `${collections.id}` as a bare
 * `"id"` in single-table queries, which inside this subquery would resolve to the entry's id.
 */
const entryCount =
  sql<number>`(select count(*) from ${vocabularyEntries} ve where ve.collection_id = "collections"."id")`.mapWith(
    Number,
  )

const rowColumns = {
  id: collections.id,
  ownerId: collections.ownerId,
  title: collections.title,
  nativeLanguage: collections.nativeLanguage,
  targetLanguage: collections.targetLanguage,
  description: collections.description,
  topic: collections.topic,
  archivedAt: collections.archivedAt,
  createdAt: collections.createdAt,
  entryCount,
}

const owned = (userId: string, id: string) => and(eq(collections.id, id), eq(collections.ownerId, userId))

export type ListResult =
  { ok: true; items: CollectionRow[]; nextCursor: string | null } | { ok: false; kind: 'invalid_cursor' }

/**
 * Keyset page, `ORDER BY created_at DESC, id DESC`. The cursor is the last item's id; its position is
 * read in SQL (owner-scoped subquery), so `timestamptz` microseconds never round-trip through a JS Date.
 */
export async function listCollections(db: Db, userId: string, q: ListCollectionsQuery): Promise<ListResult> {
  const conditions = [
    eq(collections.ownerId, userId),
    q.status === 'archived' ? isNotNull(collections.archivedAt) : isNull(collections.archivedAt),
  ]
  if (q.cursor) {
    conditions.push(
      sql`("collections"."created_at", "collections"."id") < (select cur.created_at, cur.id from ${collections} cur where cur.id = ${q.cursor} and cur.owner_id = ${userId})`,
    )
  }
  const rows = await db
    .select(rowColumns)
    .from(collections)
    .where(and(...conditions))
    .orderBy(desc(collections.createdAt), desc(collections.id))
    .limit(q.limit + 1)

  // An empty page after a cursor: the cursor may be deleted or someone else's. One owner-scoped
  // lookup tells it apart from a real end of list, without revealing whether the id exists.
  if (q.cursor && rows.length === 0) {
    const [cursorRow] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(owned(userId, q.cursor))
      .limit(1)
    if (!cursorRow) return { ok: false, kind: 'invalid_cursor' }
  }

  const hasMore = rows.length > q.limit
  const items = hasMore ? rows.slice(0, q.limit) : rows
  return { ok: true, items, nextCursor: hasMore ? items.at(-1)!.id : null }
}

export async function getCollection(db: Db, userId: string, id: string): Promise<CollectionRow | null> {
  const [row] = await db.select(rowColumns).from(collections).where(owned(userId, id)).limit(1)
  return row ?? null
}

export type CreateResult =
  | { ok: true; row: CollectionRow }
  | { ok: false; kind: 'limit_reached' }
  | { ok: false; kind: 'user_missing' }

/**
 * D3: at most COLLECTION_LIMIT per user. The user row is locked FOR NO KEY UPDATE first, so parallel
 * creates of one user serialize and each one counts the committed rows of the previous one (READ
 * COMMITTED takes a new snapshot per statement). The FK check on insert only needs KEY SHARE, which
 * this lock does not block.
 */
export async function createCollection(
  db: Db,
  userId: string,
  input: CreateCollectionInput,
): Promise<CreateResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update')
    if (!user) return { ok: false, kind: 'user_missing' } as const

    const [counted] = await tx.select({ n: count() }).from(collections).where(eq(collections.ownerId, userId))
    if ((counted?.n ?? 0) >= COLLECTION_LIMIT) return { ok: false, kind: 'limit_reached' } as const

    const [row] = await tx
      .insert(collections)
      .values({
        ownerId: userId, // only ever the session user (never from input)
        title: input.title,
        nativeLanguage: input.nativeLanguage,
        targetLanguage: input.targetLanguage,
        description: input.description ?? null,
        topic: input.topic ?? null,
      })
      .returning(rowColumns)
    return { ok: true, row: row! } as const
  })
}

export type UpdateResult =
  | { ok: true; row: CollectionRow }
  | { ok: false; kind: 'not_found' | 'archived' | 'languages_locked' | 'languages_same' }

/**
 * One owner-scoped UPDATE that skips archived rows (D2). The RC002 trigger rejects a language change
 * once the collection has entries; the CHECK rejects a single-language change equal to the other one.
 */
export async function updateCollection(
  db: Db,
  userId: string,
  id: string,
  input: UpdateCollectionInput,
): Promise<UpdateResult> {
  const set: Partial<typeof collections.$inferInsert> = {}
  if (input.title !== undefined) set.title = input.title
  if (input.nativeLanguage !== undefined) set.nativeLanguage = input.nativeLanguage
  if (input.targetLanguage !== undefined) set.targetLanguage = input.targetLanguage
  if (input.description !== undefined) set.description = input.description
  if (input.topic !== undefined) set.topic = input.topic

  let row: CollectionRow | undefined
  try {
    ;[row] = await db
      .update(collections)
      .set(set)
      .where(and(owned(userId, id), isNull(collections.archivedAt)))
      .returning(rowColumns)
  } catch (error) {
    const { code, constraint } = pgErrorInfo(error)
    if (code === 'RC002') return { ok: false, kind: 'languages_locked' }
    if (code === '23514' && constraint === 'collections_languages_differ') {
      return { ok: false, kind: 'languages_same' }
    }
    throw error
  }
  if (row) return { ok: true, row }

  const [existing] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(owned(userId, id))
    .limit(1)
  return { ok: false, kind: existing ? 'archived' : 'not_found' }
}

/** Idempotent: archiving twice keeps the first timestamp. Cards are not touched (D2). */
export async function setArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean,
): Promise<CollectionRow | null> {
  const [row] = await db
    .update(collections)
    .set({ archivedAt: archived ? sql`coalesce(${collections.archivedAt}, now())` : null })
    .where(owned(userId, id))
    .returning(rowColumns)
  return row ?? null
}

export type DeleteResult =
  | { ok: true; row: Pick<CollectionRow, 'id' | 'ownerId'> }
  | { ok: false; kind: 'mismatch'; row: Pick<CollectionRow, 'id' | 'ownerId'> }
  | { ok: false; kind: 'not_found' }

/**
 * D1: hard delete only when `confirmTitle` (NFC + trim, done by the schema) equals the stored title.
 * The owner filter comes first, so a foreign id is always not_found, whatever the title. The FK
 * cascades remove entries, cards, logs and attempts (ADR 0001 X2). Archived collections can be deleted.
 */
export async function deleteCollection(
  db: Db,
  userId: string,
  id: string,
  confirmTitle: string,
): Promise<DeleteResult> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(collections)
      .where(and(owned(userId, id), eq(collections.title, confirmTitle)))
      .returning({ id: collections.id, ownerId: collections.ownerId })
    if (deleted) return { ok: true, row: deleted } as const

    const [existing] = await tx
      .select({ id: collections.id, ownerId: collections.ownerId })
      .from(collections)
      .where(owned(userId, id))
      .limit(1)
    return existing
      ? ({ ok: false, kind: 'mismatch', row: existing } as const)
      : ({ ok: false, kind: 'not_found' } as const)
  })
}
