import { describe, expect, it } from 'vitest'
import { validateServerConfig } from '../../server/utils/env'

const local = 'postgres://u:p@localhost:5432/db'
const remote = 'postgres://u:p@db.example.com:5432/db'

describe('validateServerConfig', () => {
  it('accepts a local database in dev and in a built server', () => {
    expect(validateServerConfig({ databaseUrl: local, built: false }).databaseUrl).toBe(local)
    expect(() => validateServerConfig({ databaseUrl: local, built: true })).not.toThrow()
  })

  it('rejects a missing or empty database URL', () => {
    expect(() => validateServerConfig({ databaseUrl: undefined, built: false })).toThrow(/databaseUrl/)
    expect(() => validateServerConfig({ databaseUrl: '', built: false })).toThrow(/databaseUrl/)
  })

  it('rejects non-postgres URLs', () => {
    expect(() => validateServerConfig({ databaseUrl: 'mysql://u:p@h/db', built: false })).toThrow(/postgres/)
  })

  it('requires verified TLS for remote databases in built servers', () => {
    expect(() => validateServerConfig({ databaseUrl: remote, built: true })).toThrow(/verify-full/)
    expect(() =>
      validateServerConfig({ databaseUrl: `${remote}?sslmode=verify-full`, built: true }),
    ).not.toThrow()
  })

  it('allows remote plaintext only on the dev server', () => {
    expect(() => validateServerConfig({ databaseUrl: remote, built: false })).not.toThrow()
  })
})
