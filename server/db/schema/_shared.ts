import { customType, timestamp } from 'drizzle-orm/pg-core'

/** Case-insensitive text (extension created in migration 0000). */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' })

/** All timestamps are timestamptz, mapped to JS Date. */
export const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// CHECK bounds are written as literals inside each sql`` template: DDL can't take bound parameters
// and sql.raw is lint-banned. Language columns check the ISO 639-1 *format* only; the allow-list
// lives in shared/constants/languages.ts (ADR 0001 D5).
