// U13 (ADR 0002 §2.5, D1): built servers refuse to boot with an unsafe auth configuration, and the
// messages never contain the configured values.
import { describe, expect, it } from 'vitest'
import { authConfigSchema, validateAuthConfig, type AuthConfigInput } from '../../server/utils/env'

const good: AuthConfigInput = {
  appSecret: 'k2Vq9xM4pL7sT1wZ8bN3cR6yF0hJ5dGa',
  appOrigin: 'https://recallio.app',
  sessionName: '__Host-recallio-session',
  sessionMaxAge: 2_592_000,
  sessionCookieSecure: true,
  sessionPasswordSet: false,
  built: true,
}
const run = (patch: Partial<AuthConfigInput>) => () => validateAuthConfig({ ...good, ...patch })

describe('auth config in built servers', () => {
  it('accepts a complete configuration', () => {
    expect(run({})).not.toThrow()
    expect(run({ appOrigin: 'http://localhost:3100' })).not.toThrow()
    expect(run({ appOrigin: 'http://127.0.0.1:4000' })).not.toThrow()
  })

  it.each([
    ['missing appSecret', { appSecret: '' }, /appSecret/],
    ['31-character appSecret', { appSecret: 'x'.repeat(30) + 'y' }, /at least 32/],
    ['non-string appSecret (Nitro parsed a number)', { appSecret: 123456789012345 }, /appSecret/],
    ['placeholder appSecret', { appSecret: 'change-me-locally-0123456789abcdefghij' }, /placeholder/],
    ['repeated-character appSecret', { appSecret: 'a'.repeat(40) }, /placeholder/],
    ['NUXT_SESSION_PASSWORD set', { sessionPasswordSet: true }, /NUXT_SESSION_PASSWORD is not used/],
    ['missing appOrigin', { appOrigin: '' }, /NUXT_APP_ORIGIN is required/],
    ['http appOrigin', { appOrigin: 'http://recallio.app' }, /https/],
    ['appOrigin with a path', { appOrigin: 'https://recallio.app/app' }, /origin only/],
    ['appOrigin with a trailing slash', { appOrigin: 'https://recallio.app/' }, /origin only/],
    ['appOrigin with credentials', { appOrigin: 'https://u:p@recallio.app' }, /origin only/],
    ['insecure cookie', { sessionCookieSecure: false }, /Secure/],
    ['insecure cookie from env', { sessionCookieSecure: 'false' }, /Secure/],
    ['cookie without __Host-', { sessionName: 'nuxt-auth-session' }, /__Host-/],
    ['maxAge over 30 days', { sessionMaxAge: 2_592_001 }, /maxAge/],
    ['maxAge 0', { sessionMaxAge: 0 }, /maxAge/],
  ])('rejects %s', (_label, patch, message) => {
    expect(run(patch as Partial<AuthConfigInput>)).toThrow(message)
  })

  it('never echoes values', () => {
    const secret = 'change-me-SECRET-VALUE-xyz-0123456789'
    for (const patch of [
      { appSecret: secret },
      { appOrigin: `https://${secret}.example/path` },
      { appSecret: 'Zz9' },
    ]) {
      try {
        run(patch)()
        throw new Error('expected a failure')
      } catch (e) {
        expect(String(e)).not.toContain('SECRET-VALUE')
        expect(String(e)).not.toContain('Zz9')
      }
    }
  })

  it('does not apply on the dev server (it generates a secret)', () => {
    expect(() => validateAuthConfig({ ...good, appSecret: '', appOrigin: '', built: false })).not.toThrow()
  })

  it('has no implicit defaults and rejects unknown keys', () => {
    const { built: _b, ...withoutBuilt } = good
    expect(authConfigSchema.safeParse(withoutBuilt).success).toBe(false)
    expect(authConfigSchema.safeParse({ ...good, extra: 1 }).success).toBe(false)
  })
})
