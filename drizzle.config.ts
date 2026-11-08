import { defineConfig } from 'drizzle-kit'

const url = process.env.NUXT_DATABASE_URL
if (!url) throw new Error('NUXT_DATABASE_URL is not set (copy .env.example to .env)')

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema',
  out: './server/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
