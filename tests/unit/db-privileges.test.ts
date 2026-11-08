// D9 boot gate logic (the catalog query itself is covered by tests/integration/roles.test.ts R7).
import { describe, expect, it, vi } from 'vitest'
import { DB_ROLE_PROBLEMS, createDbRoleGate, describeDbRoleProblems } from '../../server/utils/db-privileges'

describe('createDbRoleGate', () => {
  it('opens once the role is safe and memoizes the result', async () => {
    const check = vi.fn().mockResolvedValue([])
    const onUnsafe = vi.fn()
    const gate = createDbRoleGate({ check, onUnsafe })
    expect(await gate.ensure()).toBe(true)
    expect(await gate.ensure()).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(onUnsafe).not.toHaveBeenCalled()
  })

  it('stays closed for an unsafe role and reports it once', async () => {
    const check = vi.fn().mockResolvedValue(['superuser', 'ownsRelation'])
    const onUnsafe = vi.fn()
    const gate = createDbRoleGate({ check, onUnsafe })
    expect(await gate.ensure()).toBe(false)
    expect(await gate.ensure()).toBe(false)
    expect(onUnsafe).toHaveBeenCalledTimes(1)
    expect(onUnsafe).toHaveBeenCalledWith(['superuser', 'ownsRelation'])
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('stays closed while the database is unreachable, then retries', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue([])
    const gate = createDbRoleGate({ check, onUnsafe: vi.fn() })
    expect(await gate.ensure()).toBe(false)
    expect(await gate.ensure()).toBe(true)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight check between concurrent callers', async () => {
    let resolve!: (v: never[]) => void
    const check = vi.fn(() => new Promise<never[]>((r) => (resolve = r)))
    const gate = createDbRoleGate({ check, onUnsafe: vi.fn() })
    const both = Promise.all([gate.ensure(), gate.ensure()])
    resolve([])
    expect(await both).toEqual([true, true])
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('describes problems with fixed messages only', () => {
    expect(describeDbRoleProblems(['superuser', 'databaseTemp'])).toBe(
      `${DB_ROLE_PROBLEMS.superuser}; ${DB_ROLE_PROBLEMS.databaseTemp}`,
    )
  })
})
