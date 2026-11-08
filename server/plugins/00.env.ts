// Runs first (00.*): refuse to boot with invalid configuration (fail closed).
// Validates the *effective* runtime config (NUXT_* or NITRO_* overrides), not a single env var.
// Production rules apply to every built server, regardless of NODE_ENV.
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const built = !import.meta.dev
  validateServerConfig({ databaseUrl: config.databaseUrl, built })

  // ADR 0002 §2.5. nuxt-auth-utils 0.6 seals the cookie with a key derived from appSecret; a missing
  // secret would otherwise only fail on the first request that needs a session.
  const session = config.session as
    { name?: unknown; maxAge?: unknown; password?: unknown; cookie?: { secure?: unknown } } | undefined
  validateAuthConfig({
    appSecret: config.appSecret,
    appOrigin: config.appOrigin,
    sessionName: session?.name,
    sessionMaxAge: session?.maxAge,
    sessionCookieSecure: session?.cookie?.secure,
    sessionPasswordSet: Boolean(
      process.env.NUXT_SESSION_PASSWORD || process.env.NITRO_SESSION_PASSWORD || session?.password,
    ),
    built,
  })
})
