// User persistence for auth (ADR 0002 §5.5). Takes `db`, never the event (layering rule), so the
// integration tests call it directly. Never returns password hashes to callers outside auth.
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { users } from '../../db/schema'
import type { LanguageCode } from '../../../shared/constants/languages'
import type { PublicUser } from '../../../shared/schemas/auth'
import { pgErrorInfo } from '../../utils/errors'

const publicColumns = {
  id: users.id,
  email: users.email,
  nativeLanguage: users.nativeLanguage,
  timezone: users.timezone,
  dailyNewLimit: users.dailyNewLimit,
  dailyReviewLimit: users.dailyReviewLimit,
  createdAt: users.createdAt,
}

type PublicRow = {
  id: string
  email: string
  nativeLanguage: string
  timezone: string
  dailyNewLimit: number
  dailyReviewLimit: number
  createdAt: Date
}

/** The only user DTO. Built field by field, never by spreading a row. */
export function toPublicUser(row: PublicRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    nativeLanguage: row.nativeLanguage as LanguageCode,
    timezone: row.timezone,
    dailyNewLimit: row.dailyNewLimit,
    dailyReviewLimit: row.dailyReviewLimit,
    createdAt: row.createdAt.toISOString(),
  }
}

/** For login only: the hash never leaves server/services/auth. */
export async function findCredentialsByEmail(db: Db, email: string) {
  const [row] = await db
    .select({ ...publicColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row
}

export async function findPasswordHashById(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.passwordHash
}

export async function findPublicUserById(db: Db, userId: string): Promise<PublicUser | undefined> {
  const [row] = await db.select(publicColumns).from(users).where(eq(users.id, userId)).limit(1)
  return row && toPublicUser(row)
}

export type CreateUserResult = { ok: true; user: PublicUser } | { ok: false; reason: 'duplicate_email' }

/**
 * Inserts the user. A duplicate email (citext, so case-insensitive) is a result, not a thrown 23505.
 * No pre-check select: both paths do the same work (ADR 0002 D4).
 */
export async function createUser(
  db: Db,
  input: { email: string; passwordHash: string; nativeLanguage: LanguageCode; timezone?: string },
): Promise<CreateUserResult> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
        nativeLanguage: input.nativeLanguage,
        ...(input.timezone && { timezone: input.timezone }),
      })
      .returning(publicColumns)
    return { ok: true, user: toPublicUser(row!) }
  } catch (error) {
    const { code, constraint } = pgErrorInfo(error)
    if (code === '23505' && constraint === 'users_email_key') return { ok: false, reason: 'duplicate_email' }
    throw error
  }
}

export async function updatePasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId))
}

/**
 * Hard delete (architecture §8, spec §15). One statement: the FK cascades remove every user-owned
 * row, including sessions and SRS data (ADR 0001 X1). Returns false if the user was already gone.
 */
export async function deleteUser(db: Db, userId: string): Promise<boolean> {
  const rows = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id })
  return rows.length > 0
}
