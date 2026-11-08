// U7 (ADR 0002 §6.1): the public allow-list matches exactly and fails closed.
import { describe, expect, it } from 'vitest'
import {
  PUBLIC_API_ROUTES,
  isApiPath,
  isBlockedModuleSessionRoute,
  isPublicApiRoute,
} from '../../server/utils/public-routes'

describe('isPublicApiRoute', () => {
  it.each([
    ['GET', '/api/health'],
    ['HEAD', '/api/health'],
    ['GET', '/api/health?x=1'],
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/_auth/session'],
  ])('%s %s is public', (method, path) => {
    expect(isPublicApiRoute(method, path)).toBe(true)
  })

  it.each([
    ['GET', '/api/health/'],
    ['GET', '/API/health'],
    ['GET', '/api//health'],
    ['GET', '/api/health/x'],
    ['POST', '/api/health'],
    ['POST', '/api/auth/login/'],
    ['POST', '/api/auth/login/x'],
    ['GET', '/api/auth/login'],
    ['DELETE', '/api/_auth/session'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/auth/me'],
    ['DELETE', '/api/account'],
    ['GET', '/api/nope'],
  ])('%s %s is not public', (method, path) => {
    expect(isPublicApiRoute(method, path)).toBe(false)
  })

  it('has exactly the approved entries', () => {
    expect([...PUBLIC_API_ROUTES].sort()).toEqual(
      ['GET /api/_auth/session', 'GET /api/health', 'POST /api/auth/login', 'POST /api/auth/register'].sort(),
    )
  })
})

describe('isApiPath (deliberately broad)', () => {
  it.each([
    '/api',
    '/api/',
    '/api/auth/me',
    '/API/auth/me',
    '//api/auth/me',
    '/%61pi/auth/me',
    '/api%2Fauth',
    '/api\\x',
  ])('%s → true', (p) => {
    expect(isApiPath(p)).toBe(true)
  })

  it.each(['/', '/login', '/apiary', '/_nuxt_icon/lucide.json', '/__nuxt_error', '/_nuxt/app.js'])(
    '%s → false',
    (p) => {
      expect(isApiPath(p)).toBe(false)
    },
  )
})

describe('isBlockedModuleSessionRoute (security review L1)', () => {
  it.each([
    ['DELETE', '/api/_auth/session'],
    ['DELETE', '/api/_auth/session/'],
    ['DELETE', '/api/_auth/session//'],
    ['DELETE', '/api/_auth/session/?x=1'],
    ['DELETE', '//api//_auth/session'],
    ['DELETE', '/API/_auth/Session'],
    ['DELETE', '/api/_auth/%73ession'],
    ['DELETE', '/api\\_auth\\session'],
    ['POST', '/api/_auth/session'],
    ['PUT', '/api/_auth/session/'],
    ['PATCH', '/api/_auth/session'],
  ])('%s %s → blocked', (method, path) => {
    expect(isBlockedModuleSessionRoute(method, path)).toBe(true)
  })

  it.each([
    ['GET', '/api/_auth/session'],
    ['HEAD', '/api/_auth/session'],
    ['DELETE', '/api/_auth/sessions'],
    ['DELETE', '/api/account'],
  ])('%s %s → not blocked', (method, path) => {
    expect(isBlockedModuleSessionRoute(method, path)).toBe(false)
  })
})
