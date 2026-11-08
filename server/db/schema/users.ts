import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { citext, tsz } from './_shared'

// Account deletion is a hard delete (architecture §8): there is no deleted_at (ADR 0001 D6).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    nativeLanguage: text('native_language').notNull(),
    dailyNewLimit: integer('daily_new_limit').notNull().default(20),
    dailyReviewLimit: integer('daily_review_limit').notNull().default(200),
    timezone: text('timezone').notNull().default('UTC'), // IANA name, validated by Zod (Intl)
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_len', sql`char_length(${t.email}) between 3 and 254`),
    check('users_password_hash_len', sql`char_length(${t.passwordHash}) between 1 and 512`),
    check('users_native_language_code', sql`${t.nativeLanguage} ~ '^[a-z]{2}$'`),
    check('users_daily_new_limit_range', sql`${t.dailyNewLimit} between 0 and 1000`),
    check('users_daily_review_limit_range', sql`${t.dailyReviewLimit} between 0 and 10000`),
    check('users_timezone_len', sql`char_length(${t.timezone}) between 1 and 64`),
  ],
)
