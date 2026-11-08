// Security regression tests for boot-time config validation (OWASP A02/A04/A10).
// Each case is a bypass found in the LEX-001 security review.
import { describe, expect, it } from 'vitest'
import {
  migrationConfigSchema,
  serverConfigSchema,
  validateMigrationConfig,
  validateServerConfig,
} from '../../server/utils/env'

const remote = 'postgres://recallio:pw@db.internal:5432/recallio'
const built = (databaseUrl: string) => () => validateServerConfig({ databaseUrl, built: true })

describe('config validation never leaks secret values', () => {
  const secret = 'S3cr3t-Passw0rd-xyz'
  for (const url of [
    `postgres://u:${secret}@h:notaport/db`,
    `mysql://u:${secret}@h/db`,
    secret,
    `postgres://u:${secret}@h/db`, // valid URL, fails the TLS rule
  ]) {
    it(`does not echo the value for ${url.replace(secret, '<secret>')}`, () => {
      expect(built(url)).toThrow()
      try {
        built(url)()
      } catch (e) {
        expect(String(e)).not.toContain(secret)
        expect(JSON.stringify(e)).not.toContain(secret)
      }
    })
  }
})

describe('TLS rule for built servers cannot be bypassed', () => {
  it('rejects sslmode smuggled inside the password', () => {
    expect(built('postgres://u:x-sslmode=verify-full@h:5432/db')).toThrow(/verify-full/)
  })

  it('rejects sslmode smuggled inside another query parameter', () => {
    expect(built(`${remote}?application_name=sslmode=verify-full`)).toThrow(/verify-full/)
  })

  it('rejects duplicate sslmode parameters (postgres.js keeps the last one)', () => {
    expect(built(`${remote}?sslmode=verify-full&sslmode=disable`)).toThrow(/verify-full/)
  })

  it('rejects sslmode=require (postgres.js does not verify the certificate)', () => {
    expect(built(`${remote}?sslmode=require`)).toThrow(/verify-full/)
  })

  it('rejects an additional ssl= parameter', () => {
    expect(built(`${remote}?sslmode=verify-full&ssl=false`)).toThrow(/verify-full/)
  })

  it('accepts exactly one sslmode=verify-full', () => {
    expect(built(`${remote}?sslmode=verify-full`)).not.toThrow()
  })

  it('has no implicit default for the build mode (fails closed)', () => {
    expect(serverConfigSchema.safeParse({ databaseUrl: remote }).success).toBe(false)
  })

  it('rejects unknown keys', () => {
    expect(serverConfigSchema.safeParse({ databaseUrl: remote, built: false, extra: 1 }).success).toBe(false)
  })
})

describe('migration config validation (DATABASE_MIGRATOR_URL)', () => {
  const secret = 'M1gr4t0r-Secret-xyz'
  const migration = (migratorUrl: string) => () => validateMigrationConfig({ migratorUrl })

  for (const url of [
    `postgres://m:${secret}@h:notaport/db`,
    `mysql://m:${secret}@h/db`,
    secret,
    `postgres://m:${secret}@db.internal/db`, // valid URL, fails the TLS rule
  ]) {
    it(`does not echo the value for ${url.replace(secret, '<secret>')}`, () => {
      expect(migration(url)).toThrow()
      try {
        migration(url)()
      } catch (e) {
        expect(String(e)).not.toContain(secret)
        expect(JSON.stringify(e)).not.toContain(secret)
      }
    })
  }

  it('applies the TLS rule to remote hosts (no dev-mode escape hatch)', () => {
    expect(migration(`${remote}?sslmode=verify-full&sslmode=disable`)).toThrow(/verify-full/)
    expect(migration(`${remote}?application_name=sslmode=verify-full`)).toThrow(/verify-full/)
  })

  it('rejects unknown keys', () => {
    expect(migrationConfigSchema.safeParse({ migratorUrl: remote, built: true }).success).toBe(false)
  })
})
