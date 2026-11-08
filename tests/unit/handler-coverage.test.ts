// U12 (ADR 0002 §6.2, §8.1): every handler in server/api/** that isn't on the public allow-list
// calls requireAuth(event); every allow-list entry matches a real file (or the module's route).
import { describe, expect, it } from 'vitest'
import { PUBLIC_API_ROUTES, isPublicApiRoute } from '../../server/utils/public-routes'
import { listApiRoutes } from '../helpers/api-routes'

/** Registered by nuxt-auth-utils, not a file in server/api. Validated by server/handlers/02.auth.ts. */
const MODULE_ROUTES = new Set(['GET /api/_auth/session'])

const routes = listApiRoutes()

describe('handler coverage', () => {
  it('finds the handlers', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/health',
        'POST /api/auth/login',
        'DELETE /api/account',
        'ALL /api/**',
      ]),
    )
  })

  it.each(
    routes
      .filter((r) => r.method === 'ALL' || !isPublicApiRoute(r.method, r.path))
      .map((r) => [r.file, r] as const),
  )('%s calls requireAuth(event)', (_file, route) => {
    expect(route.source).toMatch(/\brequireAuth\(event\)/)
  })

  it('every public entry is a real handler file or a known module route', () => {
    const files = new Set(routes.map((r) => `${r.method} ${r.path}`))
    for (const entry of PUBLIC_API_ROUTES) {
      expect(files.has(entry) || MODULE_ROUTES.has(entry), entry).toBe(true)
    }
  })
})
