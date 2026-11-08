import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/** The Drizzle database type. Services take it as a parameter, so tests can pass their own. */
export type Db = PostgresJsDatabase<typeof schema>

let client: ReturnType<typeof postgres> | undefined
let database: Db | undefined

/** Lazily created, process-wide Drizzle instance. All queries are parameterized by Drizzle. */
export function useDb(): Db {
  if (!database) {
    const { databaseUrl } = useRuntimeConfig()
    client = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      connection: { statement_timeout: 10_000 }, // OWASP A10: bound query time
      onnotice: () => {},
    })
    database = drizzle(client, { schema })
  }
  return database
}

export async function closeDb() {
  await client?.end({ timeout: 5 })
  client = undefined
  database = undefined
}
