import { sql } from 'drizzle-orm'
import { check, index, pgTable, uuid } from 'drizzle-orm/pg-core'
import { tsz } from './_shared'
import { users } from './users'

/**
 * Server-side sessions (ADR 0002 §2.3, D2). The sealed cookie carries only `{ user: { id }, secure: { sid } }`;
 * this row is what makes logout, idle and absolute timeouts, and account deletion exact.
 * No IP address or user agent (data minimization).
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(), // the `sid` inside the sealed cookie
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tsz('created_at').notNull().defaultNow(),
    lastSeenAt: tsz('last_seen_at').notNull().defaultNow(), // idle timeout; touched at most once an hour
    expiresAt: tsz('expires_at').notNull(), // created_at + 30 days (absolute timeout)
  },
  (t) => [
    index('user_sessions_user_id_idx').on(t.userId),
    check(
      'user_sessions_expiry',
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '30 days'`,
    ),
    check('user_sessions_seen', sql`${t.lastSeenAt} >= ${t.createdAt}`),
  ],
)
