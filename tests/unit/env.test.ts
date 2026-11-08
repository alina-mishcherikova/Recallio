import { describe, expect, it } from 'vitest'
import { validateServerEnv } from '../../server/utils/env'

const valid = { NODE_ENV: 'development', NUXT_DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

describe('validateServerEnv', () => {
  it('accepts a valid development config', () => {
    expect(validateServerEnv(valid).NUXT_DATABASE_URL).toBe(valid.NUXT_DATABASE_URL)
  })

  it('rejects a missing database URL', () => {
    expect(() => validateServerEnv({ NODE_ENV: 'development' })).toThrow(/NUXT_DATABASE_URL/)
  })

  it('rejects non-postgres URLs', () => {
    expect(() => validateServerEnv({ ...valid, NUXT_DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/postgres/)
  })

  it('requires TLS for the database in production', () => {
    expect(() => validateServerEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/sslmode/)
    expect(() =>
      validateServerEnv({
        NODE_ENV: 'production',
        NUXT_DATABASE_URL: `${valid.NUXT_DATABASE_URL}?sslmode=require`,
      }),
    ).not.toThrow()
  })

  it('never includes secret values in the error message', () => {
    const secret = 'S3cr3t-Passw0rd'
    try {
      validateServerEnv({
        ...valid,
        NODE_ENV: 'production',
        NUXT_DATABASE_URL: `postgres://u:${secret}@h/db`,
      })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).not.toContain(secret)
    }
  })
})
