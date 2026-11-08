// Contract between the shared auth schemas and every client (ADR 0002 §2.1, D7). The server's 400
// `issues` are the API contract: the web UI currently patches three gaps on its side
// (app/pages/register.vue MESSAGE_OVERRIDES, a second checkPasswordShape pass, and per-field
// de-duplication). These tests pin the contract in shared/, so any client gets it right.
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  AUTH_MESSAGES,
  PASSWORD_MESSAGES,
  loginRequestSchema,
  registerRequestSchema,
} from '../../shared/schemas/auth'
import { zodIssuesToPublic } from '../../server/utils/errors'

const FIXED = new Set<string>([...Object.values(AUTH_MESSAGES), ...Object.values(PASSWORD_MESSAGES)])

function publicIssues(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input)
  expect(result.success).toBe(false)
  return zodIssuesToPublic(result.error!)
}

describe('auth schema contract (D7)', () => {
  it('a missing or unsupported nativeLanguage has a fixed, field-specific message', () => {
    for (const nativeLanguage of [undefined, 'de', '']) {
      const issues = publicIssues(registerRequestSchema, {
        email: 'ana@example.test',
        password: 'correct horse battery staple',
        nativeLanguage,
      })
      const language = issues.filter((i) => i.path === 'nativeLanguage')
      expect(language).toHaveLength(1)
      // Today: the generic fallback "Choose one of the allowed values." (languageCodeSchema has no message).
      expect(FIXED, `message: ${language[0]!.message}`).toContain(language[0]!.message)
    }
  })

  it('the password policy is reported in the same pass as an invalid nativeLanguage', () => {
    const issues = publicIssues(registerRequestSchema, { email: 'someone@example.test', password: 'aaaa' })
    expect(issues).toContainEqual({ path: 'password', message: PASSWORD_MESSAGES.too_short })
    expect(issues.some((i) => i.path === 'nativeLanguage')).toBe(true)
  })

  it.each([
    ['register', registerRequestSchema, { email: '', password: 'aaaa', nativeLanguage: 'en' }],
    ['login', loginRequestSchema, { email: '', password: 'x' }],
    ['login (spaces only)', loginRequestSchema, { email: '   ', password: 'x' }],
  ] as const)('%s: an empty email gives one issue, not duplicates', (_label, schema, input) => {
    const issues = publicIssues(schema, input)
    const keys = issues.map((i) => `${i.path}|${i.message}`)
    expect(keys).toEqual([...new Set(keys)])
    expect(issues.filter((i) => i.path === 'email')).toEqual([
      { path: 'email', message: AUTH_MESSAGES.invalidEmail },
    ])
  })
})
