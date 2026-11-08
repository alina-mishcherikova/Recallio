// Runs before every handler, including nuxt-security's rate limiter, which keys on the
// left-most X-Forwarded-For value. We overwrite that header with the single trusted client IP, so
// spoofed values can't reset rate-limit buckets (LEX-001 security review, M1). IPv6 clients are
// counted per /64 (LEX-003 security review, M1).
export default defineNitroPlugin((nitroApp) => {
  const trustedHeader = useRuntimeConfig().trustedIpHeader || undefined

  nitroApp.hooks.hook('request', (event) => {
    const req = event.node.req
    const ip = resolveClientIp({
      socketAddress: req.socket?.remoteAddress,
      headers: req.headers,
      trustedHeader,
    })
    // nuxt-security's limiter keys on X-Forwarded-For: give it the same subject as the auth limits
    // (IPv6 /64, unwrapped IPv4-mapped). Audit logs keep the full address in event.context.clientIp.
    req.headers['x-forwarded-for'] = rateLimitSubject(ip)
    delete req.headers['x-real-ip']
    event.context.clientIp = ip
  })
})

declare module 'h3' {
  interface H3EventContext {
    clientIp?: string
  }
}
