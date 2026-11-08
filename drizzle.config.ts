import { existsSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'
// Relative import: drizzle-kit runs outside Nuxt. env.ts only depends on zod.
import { validateMigrationConfig } from './server/utils/env'

// Local convenience: read .env if present. Never overrides variables that are already set.
if (existsSync('.env')) process.loadEnvFile('.env')

// `generate` and `check` work offline from the schema files; every other command needs the database.
const offline = process.argv.some((arg) => arg === 'generate' || arg === 'check')

// Migrations run as the migrator role (DDL owner). The runtime app role (NUXT_DATABASE_URL) can't run DDL.
const dbCredentials = offline
  ? undefined
  : { url: validateMigrationConfig({ migratorUrl: process.env.DATABASE_MIGRATOR_URL }).migratorUrl }

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema',
  out: './server/db/migrations',
  ...(dbCredentials && { dbCredentials }),
  strict: true,
  verbose: true,
})
