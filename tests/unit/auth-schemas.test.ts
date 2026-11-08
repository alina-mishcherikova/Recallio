// U4–U5 (ADR 0002 §2.1, §8.1): request schemas are strict and bounded; the user DTO has no secrets.
import { describe, expect, it } from 'vitest'
import {
  AUTH_MESSAGES,
  deleteAccountRequestSchema,
  emailSchema,
  isSupportedTimeZone,
  loginRequestSchema,
  logoutRequestSchema,
  publicUserSchema,
  registerRequestSchema,
  tooManyAttemptsMessage,
} from '../../shared/schemas/auth'
import { toPublicUser } from '../../server/services/auth/users'

const register = { email: 'ana@example.test', password: 'correct horse battery staple', nativeLanguage: 'fr' }

describe('strict schemas reject unknown keys (U4)', () => {
  it.each([
    ['register', registerRequestSchema, register],
    ['login', loginRequestSchema, { email: 'ana@example.test', password: 'x' }],
    ['logout', logoutRequestSchema, { scope: 'all' }],
    ['delete account', deleteAccountRequestSchema, { password: 'x' }],
  ])('%s', (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, userId: '00000000-0000-4000-8000-000000000000' }).success).toBe(false)
  })

  it('publicUserSchema', () => {
    const user = {
      id: '00000000-0000-4000-8000-000000000000',
      email: 'a@b.cd',
      nativeLanguage: 'en',
      timezone: 'UTC',
      dailyNewLimit: 20,
      dailyReviewLimit: 200,
      createdAt: new Date().toISOString(),
    }
    expect(publicUserSchema.safeParse(user).success).toBe(true)
    expect(publicUserSchema.safeParse({ ...user, passwordHash: '$scrypt$' }).success).toBe(false)
  })
})

describe('email (U4)', () => {
  it('trims and lowercases', () => {
    expect(emailSchema.parse('  Ana.Smith@Example.TEST ')).toBe('ana.smith@example.test')
  })

  it('rejects 255 characters and a 65-character local part, with the fixed message', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(185)}.test` // 255
    expect(long.length).toBe(255)
    const r = emailSchema.safeParse(long)
    expect(r.success).toBe(false)
    expect(r.error!.issues.every((i) => i.message === AUTH_MESSAGES.invalidEmail)).toBe(true)
    expect(emailSchema.safeParse(`${'a'.repeat(65)}@example.test`).success).toBe(false)
    expect(emailSchema.safeParse(`${'a'.repeat(64)}@example.test`).success).toBe(true)
  })

  it.each(['', 'not-an-email', 'a@b', '@example.test', 42, null])('rejects %j', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false)
  })
})

describe('register (U4)', () => {
  it("rejects nativeLanguage 'de' and a bad timezone; accepts a valid IANA zone", () => {
    expect(registerRequestSchema.safeParse({ ...register, nativeLanguage: 'de' }).success).toBe(false)
    expect(registerRequestSchema.safeParse({ ...register, timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(registerRequestSchema.safeParse({ ...register, timezone: '../../etc' }).success).toBe(false)
    expect(registerRequestSchema.parse({ ...register, timezone: 'Europe/Paris' }).timezone).toBe(
      'Europe/Paris',
    )
  })

  it('reports policy issues on the password path', () => {
    const r = registerRequestSchema.safeParse({ ...register, password: 'short' })
    expect(r.success).toBe(false)
    expect(r.error!.issues).toContainEqual(expect.objectContaining({ path: ['password'] }))
  })

  it('normalizes the password (NFKC)', () => {
    expect(
      registerRequestSchema.parse({ ...register, password: 'ｃｏｒｒｅｃｔ horse battery' }).password,
    ).toBe('correct horse battery')
  })

  it('timezone check is Intl-backed', () => {
    expect(isSupportedTimeZone('UTC')).toBe(true)
    expect(isSupportedTimeZone('America/Argentina/Salta')).toBe(true)
    expect(isSupportedTimeZone('Nowhere/Land')).toBe(false)
    expect(isSupportedTimeZone('+01:00')).toBe(false)
  })
})

describe('password input bounds (U4)', () => {
  it('rejects 1025 UTF-16 units at login and accepts 1024', () => {
    const email = 'ana@example.test'
    expect(loginRequestSchema.safeParse({ email, password: 'x'.repeat(1025) }).success).toBe(false)
    expect(loginRequestSchema.safeParse({ email, password: 'x'.repeat(1024) }).success).toBe(true)
    expect(loginRequestSchema.safeParse({ email, password: '' }).success).toBe(false)
  })

  it('logout accepts an empty body', () => {
    expect(logoutRequestSchema.parse(undefined)).toEqual({ scope: 'current' })
    expect(logoutRequestSchema.parse({})).toEqual({ scope: 'current' })
    expect(logoutRequestSchema.safeParse({ scope: 'everyone' }).success).toBe(false)
  })

  it('429 message rounds up to minutes', () => {
    expect(tooManyAttemptsMessage(15)).toBe('Too many attempts. Try again in 1 minute.')
    expect(tooManyAttemptsMessage(61)).toBe('Too many attempts. Try again in 2 minutes.')
  })
})

describe('user DTO (U5)', () => {
  it('has exactly the schema keys, never the hash', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000000',
      email: 'a@b.cd',
      nativeLanguage: 'en',
      timezone: 'UTC',
      dailyNewLimit: 20,
      dailyReviewLimit: 200,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      passwordHash: '$scrypt$n=16384,r=8,p=5$abc$def',
    }
    const dto = toPublicUser(row)
    expect(Object.keys(dto).sort()).toEqual(Object.keys(publicUserSchema.shape).sort())
    expect(publicUserSchema.parse(dto)).toEqual(dto)
    expect(JSON.stringify(dto)).not.toContain('scrypt')
  })
})
