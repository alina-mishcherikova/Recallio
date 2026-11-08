import { useDbRoleGate } from '../db/role-gate'

// Fail closed (ADR 0001 D9): until the runtime DB role is verified as least-privilege, a built
// server serves nothing but the health probe. Nitro ignores errors thrown from `request` hooks, so
// this gate is a middleware.
export default defineEventHandler(async (event) => {
  if (import.meta.dev || event.path.split('?')[0] === '/api/health') return
  if (!(await useDbRoleGate().ensure())) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' })
  }
})
