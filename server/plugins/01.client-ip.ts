// Runs before every handler, including nuxt-security's rate limiter, which keys on the
// left-most X-Forwarded-For value. We overwrite that header with the single trusted client IP, so
// spoofed values can't reset rate-limit buckets (LEX-001 security review, M1).
export default defineNitroPlugin((nitroApp) => {
  const trustedHeader = useRuntimeConfig().trustedIpHeader || undefined

  nitroApp.hooks.hook('request', (event) => {
    const req = event.node.req
    const ip = resolveClientIp({
      socketAddress: req.socket?.remoteAddress,
      headers: req.headers,
      trustedHeader,
    })
    req.headers['x-forwarded-for'] = ip
    delete req.headers['x-real-ip']
    event.context.clientIp = ip
  })
})

declare module 'h3' {
  interface H3EventContext {
    clientIp?: string
  }
}
