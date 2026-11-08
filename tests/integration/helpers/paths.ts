import { fileURLToPath } from 'node:url'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../server/db/migrations', import.meta.url))
