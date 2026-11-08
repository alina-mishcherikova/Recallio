import { z } from 'zod'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * A postgres:// URL. One guarded check: `new URL()` errors would echo the (secret) input.
 * Error messages never contain values.
 */
export const databaseUrlSchema = z
  .string({ error: 'is required' })
  .min(1, 'is required')
  .refine((v) => URL.canParse(v) && /^postgres(ql)?:$/.test(new URL(v).protocol), {
    message: 'must be a valid postgres:// URL',
    abort: true,
  })

/**
 * TLS rule: a connection to a non-loopback database must use `sslmode=verify-full` (certificate +
 * hostname verification). `require` is rejected because postgres.js maps it to
 * `rejectUnauthorized: false`, which allows MITM. Returns an error message, or null when the URL is OK.
 */
export function databaseUrlTlsProblem(databaseUrl: string): string | null {
  if (!URL.canParse(databaseUrl)) return null // reported by databaseUrlSchema
  const url = new URL(databaseUrl)
  if (LOOPBACK_HOSTS.has(url.hostname)) return null

  const sslmodes = url.searchParams.getAll('sslmode')
  const ok = sslmodes.length === 1 && sslmodes[0] === 'verify-full' && !url.searchParams.has('ssl')
  return ok
    ? null
    : 'non-local database connections must set exactly one sslmode=verify-full (and no ssl= parameter)'
}

/**
 * Server configuration schema (OWASP A02/A04/A10). Validated once at boot against the *effective*
 * runtime config; the server refuses to start on invalid config. Only the dev server may skip TLS
 * for remote hosts.
 */
export const serverConfigSchema = z
  .object({
    databaseUrl: databaseUrlSchema,
    built: z.boolean(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.built) return
    const problem = databaseUrlTlsProblem(cfg.databaseUrl)
    if (problem) ctx.addIssue({ code: 'custom', path: ['databaseUrl'], message: problem })
  })

export type ServerConfig = z.infer<typeof serverConfigSchema>

/**
 * Migration configuration (drizzle-kit and integration-test setup). The migrator URL never reaches
 * the server bundle: it has no NUXT_ prefix and is not in nuxt.config.ts. Remote hosts always need
 * verified TLS, whether or not a server is built.
 */
export const migrationConfigSchema = z
  .object({ migratorUrl: databaseUrlSchema })
  .strict()
  .superRefine((cfg, ctx) => {
    const problem = databaseUrlTlsProblem(cfg.migratorUrl)
    if (problem) ctx.addIssue({ code: 'custom', path: ['migratorUrl'], message: problem })
  })

export type MigrationConfig = z.infer<typeof migrationConfigSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  let result: z.ZodSafeParseResult<T>
  try {
    result = schema.safeParse(input)
  } catch {
    // Never surface unexpected errors: they may contain configuration values.
    throw new Error(`Invalid ${label}: could not be validated`)
  }
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid ${label}:\n  - ${problems.join('\n  - ')}`)
  }
  return result.data
}

/** Throws with variable names and messages only — never their values. */
export function validateServerConfig(input: { databaseUrl: unknown; built: boolean }): ServerConfig {
  return parseOrThrow(serverConfigSchema, input, 'server configuration')
}

/** Throws with variable names and messages only — never their values. */
export function validateMigrationConfig(input: { migratorUrl: unknown }): MigrationConfig {
  return parseOrThrow(migrationConfigSchema, input, 'migration configuration')
}
