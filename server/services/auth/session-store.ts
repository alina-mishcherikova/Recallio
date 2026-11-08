// Server-side session rows (ADR 0002 §2.3, §4.2, D2). Takes `db`, never the event.
// Every time comparison uses the database clock (`now()`), so app-server clock drift doesn't matter.
import { and, eq, lte, or, sql } from 'drizzle-orm'
import { z } from '../../../shared/zod'
import type { Db } from '../../db/client'
import { userSessions, users } from '../../db/schema'

export const SESSION_LIMITS = Object.freeze({
  /** Absolute lifetime. The DB check `user_sessions_expiry` enforces the same bound. */
  absolute: '30 days',
  idle: '7 days',
  /** last_seen_at is written at most once per this interval (the idle window may end up to 1 h early). */
  touch: '1 hour',
  maxActivePerUser: 10,
})

const uuidSchema = z.uuid()

export type SessionCheck =
  { ok: true } | { ok: false; reason: 'expired' | 'idle' | 'revoked' | 'user_missing' | 'malformed' }

const activeCondition = sql`${userSessions.expiresAt} > now() and ${userSessions.lastSeenAt} > now() - interval '7 days'`
const inactiveCondition = or(
  lte(userSessions.expiresAt, sql`now()`),
  lte(userSessions.lastSeenAt, sql`now() - interval '7 days'`),
)

/**
 * Creates a session row for a login or a registration (rotation, §4.4). In one transaction:
 * deletes the session presented with the request (if any), the user's expired or idle rows, and the
 * oldest active rows above the cap of 10; then inserts the new row. Returns the new `sid`.
 */
export async function createSession(
  db: Db,
  userId: string,
  opts: { replaceSessionId?: string } = {},
): Promise<string> {
  return db.transaction(async (tx) => {
    const replace = opts.replaceSessionId
    if (replace && uuidSchema.safeParse(replace).success) {
      await tx.delete(userSessions).where(eq(userSessions.id, replace))
    }
    await tx.delete(userSessions).where(and(eq(userSessions.userId, userId), inactiveCondition))
    // Keep at most 9 existing active rows, so the new one makes 10.
    await tx.execute(sql`
      delete from ${userSessions}
       where ${userSessions.id} in (
         select ${userSessions.id} from ${userSessions}
          where ${userSessions.userId} = ${userId}
          order by ${userSessions.createdAt} desc, ${userSessions.id} desc
          offset ${SESSION_LIMITS.maxActivePerUser - 1})`)
    const [row] = await tx
      .insert(userSessions)
      .values({ userId, expiresAt: sql`now() + interval '30 days'` })
      .returning({ id: userSessions.id })
    return row!.id
  })
}

/**
 * The per-request check (§4.2): the row exists, belongs to `userId`, is within the absolute and idle
 * timeouts. Expired or idle rows are deleted. `last_seen_at` is touched when it is over 1 hour old.
 */
export async function checkSession(
  db: Db,
  presented: { sid: string; userId: string },
): Promise<SessionCheck> {
  if (!uuidSchema.safeParse(presented.sid).success || !uuidSchema.safeParse(presented.userId).success) {
    return { ok: false, reason: 'malformed' }
  }
  const [row] = await db
    .select({
      userId: userSessions.userId,
      live: sql<boolean>`${userSessions.expiresAt} > now()`,
      active: sql<boolean>`${userSessions.lastSeenAt} > now() - interval '7 days'`,
      stale: sql<boolean>`${userSessions.lastSeenAt} < now() - interval '1 hour'`,
    })
    .from(userSessions)
    .where(eq(userSessions.id, presented.sid))
    .limit(1)

  if (!row || row.userId !== presented.userId) {
    // The FK cascade removes a deleted user's rows, so tell the two cases apart for the audit log.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, presented.userId))
      .limit(1)
    return { ok: false, reason: user ? 'revoked' : 'user_missing' }
  }
  if (!row.live || !row.active) {
    await db.delete(userSessions).where(eq(userSessions.id, presented.sid))
    return { ok: false, reason: row.live ? 'idle' : 'expired' }
  }
  if (row.stale) {
    await db
      .update(userSessions)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(eq(userSessions.id, presented.sid), sql`${userSessions.lastSeenAt} < now() - interval '1 hour'`),
      )
  }
  return { ok: true }
}

/** Logout (`scope: 'current'`). Scoped to the user: a sid of another user is never touched. */
export async function revokeSession(db: Db, userId: string, sid: string): Promise<void> {
  await db.delete(userSessions).where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId)))
}

/** Logout everywhere (`scope: 'all'`). Later reused by password and email change. */
export async function revokeAllSessions(db: Db, userId: string): Promise<number> {
  const rows = await db
    .delete(userSessions)
    .where(eq(userSessions.userId, userId))
    .returning({ id: userSessions.id })
  return rows.length
}

/** Hourly sweep of expired and idle rows (server/plugins/04.auth-boot.ts). */
export async function sweepSessions(db: Db): Promise<number> {
  const rows = await db.delete(userSessions).where(inactiveCondition).returning({ id: userSessions.id })
  return rows.length
}

/** Active sessions of a user (tests and a future "devices" list). */
export async function countActiveSessions(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), activeCondition))
  return row?.n ?? 0
}
