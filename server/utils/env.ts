import { z } from 'zod'

/**
 * Server environment schema. Validated once at boot; the server refuses to start on invalid config
 * (fail closed — OWASP A02/A10). Values are never logged.
 */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    NUXT_DATABASE_URL: z
      .string()
      .url()
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      !/sslmode=(require|verify-full|verify-ca)/.test(env.NUXT_DATABASE_URL)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['NUXT_DATABASE_URL'],
        message: 'production database connections must use TLS (sslmode=require or stricter)',
      })
    }
  })

export type ServerEnv = z.infer<typeof serverEnvSchema>

/** Returns only the names of invalid variables and their messages — never their values. */
export function validateServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid server environment:\n  - ${problems.join('\n  - ')}`)
  }
  return result.data
}
