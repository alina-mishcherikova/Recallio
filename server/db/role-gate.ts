import { createDbRoleGate, describeDbRoleProblems, findDbRoleProblems } from '../utils/db-privileges'
import type { DbRoleGate } from '../utils/db-privileges'
import { useDb } from './client'

let gate: DbRoleGate | undefined

/**
 * Process-wide gate for built servers (ADR 0001 D9). An over-privileged role stops the process:
 * the server must never serve requests with a role that can change the schema.
 */
export function useDbRoleGate(): DbRoleGate {
  gate ??= createDbRoleGate({
    check: () => findDbRoleProblems(useDb()),
    onUnsafe: (problems) => {
      console.error(
        `Refusing to start: the database role in NUXT_DATABASE_URL ${describeDbRoleProblems(problems)}. ` +
          'Use the runtime app role (DML only).',
      )
      process.exit(1)
    },
  })
  return gate
}
