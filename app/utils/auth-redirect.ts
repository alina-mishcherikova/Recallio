// Page-level redirects for the auth middleware and the login/register pages (ADR 0002 §6.4).
// Every redirect target goes through `safeRedirectPath` (same-origin paths only, no open redirect).
import type { LocationQueryValue, RouteLocationRaw } from 'vue-router'
import { DEFAULT_REDIRECT_PATH, safeRedirectPath } from '#shared/auth/redirect'

/** Pages that a signed-in user is sent away from. Never used as a post-login target (no loops). */
const GUEST_PATHS = ['/login', '/register']

function isGuestPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || '/'
  return GUEST_PATHS.includes(pathname.toLowerCase())
}

/**
 * Where to go after a successful login or registration. Takes the raw `?redirect=` query value
 * (string, array or missing) and returns a same-origin path.
 */
export function postAuthPath(redirect: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const path = safeRedirectPath(redirect)
  return isGuestPath(path) ? DEFAULT_REDIRECT_PATH : path
}

/** The login location for a guest who tried to open `fullPath`. */
export function loginLocation(fullPath: string): RouteLocationRaw {
  return { path: '/login', query: { redirect: postAuthPath(fullPath) } }
}

/** Forwards a sanitized `?redirect=` between /login and /register. Omitted when it's the default. */
export function redirectQuery(
  redirect: LocationQueryValue | LocationQueryValue[] | undefined,
): Record<string, string> {
  const path = postAuthPath(redirect)
  return path === DEFAULT_REDIRECT_PATH ? {} : { redirect: path }
}
