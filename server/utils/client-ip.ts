import { isIP, isIPv4, isIPv6 } from 'node:net'

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

/** The 8 hextets of a valid IPv6 address (with `::` and an optional dotted IPv4 tail). */
function ipv6Hextets(address: string): number[] {
  let value = address
  const tail: number[] = []
  const lastColon = value.lastIndexOf(':')
  const dotted = value.slice(lastColon + 1)
  if (isIPv4(dotted)) {
    const [a, b, c, d] = dotted.split('.').map(Number) as [number, number, number, number]
    tail.push((a << 8) | b, (c << 8) | d)
    value = `${value.slice(0, lastColon + 1)}0:0` // placeholder hextets, replaced below
  }
  const [head, rest] = value.includes('::') ? value.split('::') : [value, undefined]
  const parse = (part: string | undefined) => (part ? part.split(':').map((h) => parseInt(h, 16)) : [])
  const left = parse(head)
  const right = parse(rest)
  const hextets =
    rest === undefined
      ? left
      : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
  if (tail.length) hextets.splice(6, 2, ...tail)
  return hextets
}

/**
 * The subject a per-IP rate limit counts (OWASP A07): an IPv4 address as is (IPv4-mapped IPv6
 * addresses are unwrapped), or the IPv6 /64 network as `a:b:c:d::`. One customer usually gets a whole
 * /64, so keying on the full address would let a client rotate addresses and never hit a limit.
 * Audit logs keep the full address (event.context.clientIp). Anything else is returned unchanged.
 */
export function rateLimitSubject(ip: string): string {
  const value = ip.trim().toLowerCase().split('%', 1)[0]!
  if (isIPv4(value)) return value
  if (!isIPv6(value)) return ip
  const h = ipv6Hextets(value)
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return [h[6]! >> 8, h[6]! & 255, h[7]! >> 8, h[7]! & 255].join('.')
  }
  return `${h
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::`
}
