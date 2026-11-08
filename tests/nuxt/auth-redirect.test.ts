// Redirect sanitizer and page access middleware (ADR 0002 §6.4, U6; OWASP A01 open redirect).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { RouteLocationNormalized } from 'vue-router'
import { safeRedirectPath } from '#shared/auth/redirect'
import { loginLocation, postAuthPath, redirectQuery } from '~/utils/auth-redirect'
import authMiddleware from '~/middleware/auth.global'

const { session, navigateToMock } = vi.hoisted(() => ({
  session: { loggedIn: { value: false } },
  navigateToMock: vi.fn((to: unknown, _opts?: unknown) => to),
}))

mockNuxtImport('useUserSession', () => () => session)
mockNuxtImport('navigateTo', () => navigateToMock)

const HOSTILE = [
  '//evil.example',
  '//evil.example/dashboard',
  '/\\evil.example',
  '\\\\evil.example',
  'https://evil.example',
  'http:/evil.example',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,hi',
  '/%2f%2fevil.example',
  '/%5cevil.example',
  '/%0d%0aSet-Cookie:x',
  '/\t/evil.example',
  '/\n/evil.example',
  'evil.example',
  '',
  `/${'a'.repeat(600)}`,
]

describe('safeRedirectPath (shared)', () => {
  it.each(HOSTILE)('rejects %j', (input) => {
    expect(safeRedirectPath(input)).toBe('/dashboard')
  })

  it.each([undefined, null, 42, ['/account'], { path: '/account' }])('rejects non-strings: %j', (input) => {
    expect(safeRedirectPath(input)).toBe('/dashboard')
  })

  it.each(['/account', '/collections/1?x=1', '/dashboard#top'])('keeps same-origin path %j', (input) => {
    expect(safeRedirectPath(input)).toBe(input)
  })
})

describe('postAuthPath', () => {
  it.each(HOSTILE)('falls back to /dashboard for %j', (input) => {
    expect(postAuthPath(input)).toBe('/dashboard')
  })

  it('takes a query array as hostile input', () => {
    expect(postAuthPath(['/account', '/collections'])).toBe('/dashboard')
  })

  it.each(['/login', '/register', '/login?redirect=/account', '/Register/', '/login#x'])(
    'never sends a signed-in user back to a guest page (%j)',
    (input) => {
      expect(postAuthPath(input)).toBe('/dashboard')
    },
  )

  it('keeps a protected page', () => {
    expect(postAuthPath('/account')).toBe('/account')
  })
})

describe('redirectQuery', () => {
  it('omits the default and hostile targets', () => {
    expect(redirectQuery(undefined)).toEqual({})
    expect(redirectQuery('/dashboard')).toEqual({})
    expect(redirectQuery('//evil.example')).toEqual({})
  })

  it('forwards a safe target', () => {
    expect(redirectQuery('/account')).toEqual({ redirect: '/account' })
  })
})

function route(path: string, auth?: 'public' | 'guest'): RouteLocationNormalized {
  return { path, fullPath: path, meta: auth ? { auth } : {}, query: {} } as unknown as RouteLocationNormalized
}

async function run(to: RouteLocationNormalized) {
  return await authMiddleware(to, route('/'))
}

describe('auth.global middleware', () => {
  beforeEach(() => {
    navigateToMock.mockClear()
  })

  describe('as a guest', () => {
    beforeEach(() => {
      session.loggedIn.value = false
    })

    it('sends a protected page to /login with the page as redirect', async () => {
      const result = await run(route('/account?tab=profile'))
      expect(result).toEqual({ path: '/login', query: { redirect: '/account?tab=profile' } })
      expect(navigateToMock).toHaveBeenCalledWith(expect.anything(), { replace: true })
    })

    it('treats pages without meta as protected (deny by default)', async () => {
      expect(await run(route('/dashboard'))).toEqual({ path: '/login', query: { redirect: '/dashboard' } })
    })

    it('never puts a hostile path in the redirect parameter', async () => {
      expect(await run(route('//evil.example'))).toEqual({
        path: '/login',
        query: { redirect: '/dashboard' },
      })
    })

    it('lets guests open public and guest pages', async () => {
      expect(await run(route('/', 'public'))).toBeUndefined()
      expect(await run(route('/login', 'guest'))).toBeUndefined()
      expect(navigateToMock).not.toHaveBeenCalled()
    })
  })

  describe('when signed in', () => {
    beforeEach(() => {
      session.loggedIn.value = true
    })

    it('sends guest pages to /dashboard', async () => {
      expect(await run(route('/login', 'guest'))).toBe('/dashboard')
      expect(await run(route('/register', 'guest'))).toBe('/dashboard')
    })

    it('lets the user open protected and public pages', async () => {
      expect(await run(route('/account'))).toBeUndefined()
      expect(await run(route('/', 'public'))).toBeUndefined()
      expect(navigateToMock).not.toHaveBeenCalled()
    })
  })

  it('loginLocation matches what the middleware builds', () => {
    expect(loginLocation('/account')).toEqual({ path: '/login', query: { redirect: '/account' } })
  })
})
