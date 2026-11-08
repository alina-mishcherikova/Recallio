import { z } from 'zod'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Server configuration schema (OWASP A02/A04/A10). Validated once at boot against the *effective*
 * runtime config; the server refuses to start on invalid config. Error messages never contain values.
 *
 * TLS rule: a built server talking to a non-loopback database must use `sslmode=verify-full`
 * (certificate + hostname verification). `require` is rejected because postgres.js maps it to
 * `rejectUnauthorized: false`, which allows MITM. Only the dev server and loopback hosts may skip TLS.
 */
export const serverConfigSchema = z
  .object({
    databaseUrl: z
      .string({ error: 'is required' })
      .min(1, 'is required')
      // One guarded check: `new URL()` errors would echo the (secret) input.
      .refine((v) => URL.canParse(v) && /^postgres(ql)?:$/.test(new URL(v).protocol), {
        message: 'must be a valid postgres:// URL',
        abort: true,
      }),
    built: z.boolean(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.built || !URL.canParse(cfg.databaseUrl)) return
    const url = new URL(cfg.databaseUrl)
    if (LOOPBACK_HOSTS.has(url.hostname)) return

    const sslmodes = url.searchParams.getAll('sslmode')
    const ok = sslmodes.length === 1 && sslmodes[0] === 'verify-full' && !url.searchParams.has('ssl')
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message:
          'non-local database connections must set exactly one sslmode=verify-full (and no ssl= parameter)',
      })
    }
  })

export type ServerConfig = z.infer<typeof serverConfigSchema>

/** Throws with variable names and messages only — never their values. */
export function validateServerConfig(input: { databaseUrl: unknown; built: boolean }): ServerConfig {
  let result: ReturnType<typeof serverConfigSchema.safeParse>
  try {
    result = serverConfigSchema.safeParse(input)
  } catch {
    // Never surface unexpected errors: they may contain configuration values.
    throw new Error('Invalid server configuration: databaseUrl could not be validated')
  }
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid server configuration:\n  - ${problems.join('\n  - ')}`)
  }
  return result.data
}
