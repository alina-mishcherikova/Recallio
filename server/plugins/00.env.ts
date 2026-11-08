// Runs first (00.*): refuse to boot with invalid configuration (fail closed).
// Validates the *effective* runtime config (NUXT_* or NITRO_* overrides), not a single env var.
// Production rules apply to every built server, regardless of NODE_ENV.
export default defineNitroPlugin(() => {
  validateServerConfig({
    databaseUrl: useRuntimeConfig().databaseUrl,
    built: !import.meta.dev,
  })
})
