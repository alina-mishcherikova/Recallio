import { describeDbRoleProblems, findDbRoleProblems } from '../utils/db-privileges'
import { useDb } from '../db/client'
import { useDbRoleGate } from '../db/role-gate'

// Runs after config validation (00.env.ts). Least privilege (ADR 0001 D9): a built server exits if
// its DB role is a superuser, can run DDL, or owns objects. If the DB is unreachable at boot, the
// server stays closed (server/middleware/00.db-role.ts answers 503) and re-checks on the next request.
// The dev server only warns, so a local misconfiguration is visible without blocking work.
export default defineNitroPlugin(() => {
  if (!import.meta.dev) {
    void useDbRoleGate().ensure()
    return
  }
  findDbRoleProblems(useDb()).then(
    (problems) => {
      if (problems.length > 0) {
        console.warn(
          `[dev] The database role in NUXT_DATABASE_URL ${describeDbRoleProblems(problems)}. ` +
            'A built server refuses to start with this role.',
        )
      }
    },
    () => console.warn('[dev] Could not verify database role privileges (database unreachable?)'),
  )
})
