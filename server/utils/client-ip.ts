import { isIP } from 'node:net'

/**
 * Resolves the client IP we trust for rate limiting and audit logs (OWASP A06/A07).
 *
 * - `trustedHeader` unset (default): use the TCP socket address. Client-supplied
 *   X-Forwarded-For / X-Real-IP are ignored.
 * - `trustedHeader` set (e.g. `fly-client-ip`, `x-real-ip`): ONLY set this when the app runs behind
 *   a proxy that always overwrites that header. A missing or invalid value falls back to the socket.
 */
export function resolveClientIp(opts: {
  socketAddress: string | undefined
  headers: Record<string, string | string[] | undefined>
  trustedHeader?: string
}): string {
  if (opts.trustedHeader) {
    const raw = opts.headers[opts.trustedHeader.toLowerCase()]
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
    if (value && isIP(value)) return value
  }
  const socket = opts.socketAddress?.replace(/^::ffff:/, '')
  return socket && isIP(socket) ? socket : 'unknown'
}
