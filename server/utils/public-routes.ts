// Public API allow-list (ADR 0002 §6.1; architecture §8 A01). Everything else under /api/** needs a
// session. Matching is exact on the method and the path without the query string: no prefixes, no
// globs, no trailing-slash or case normalization. Anything that doesn't match exactly fails closed.
export const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/health',
  'POST /api/auth/register',
  'POST /api/auth/login',
  'GET /api/_auth/session', // nuxt-auth-utils module route, validated by server/handlers/02.auth.ts
])

/** `path` is `event.path` (it may include a query string). HEAD is matched as GET. */
export function isPublicApiRoute(method: string, path: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method
  const pathname = path.split('?', 1)[0]!.split('#', 1)[0]!
  return PUBLIC_API_ROUTES.has(`${m} ${pathname}`)
}

/**
 * True for anything the router could treat as an API path. Deliberately broad (case, repeated
 * slashes, percent-encoding): a wider match only means more requests need a session.
 */
export function isApiPath(path: string): boolean {
  const pathname = path.split('?', 1)[0]!
  if (pathname === '/api' || pathname.startsWith('/api/')) return true
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // malformed escapes: judge the raw value
  }
  return /^\/+api(?:[/\\]|$)/i.test(decoded.replace(/\\/g, '/'))
}

/**
 * Every spelling the router could treat as the same path: percent-decoded, backslashes as slashes,
 * repeated and trailing slashes collapsed, lower case, no query. For deny rules only (fail closed);
 * the allow-list above stays exact.
 */
export function normalizeApiPath(path: string): string {
  let pathname = path.split('?', 1)[0]!.split('#', 1)[0]!
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // malformed escapes: judge the raw value
  }
  const collapsed = pathname
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
  return (collapsed || '/').toLowerCase()
}

/**
 * The module's `DELETE /api/_auth/session` clears the cookie without revoking the session row or
 * writing an audit line. Every method except GET/HEAD on any spelling of that path is blocked.
 */
export function isBlockedModuleSessionRoute(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  return normalizeApiPath(path) === '/api/_auth/session'
}
