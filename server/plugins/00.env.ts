// Runs first (00.*): refuse to boot with invalid configuration.
// Built servers default to production rules when NODE_ENV is unset (fail closed).
export default defineNitroPlugin(() => {
  // Copy first: the bundler statically replaces `process.env.NODE_ENV`, but not lookups on a copy.
  const env: Record<string, string | undefined> = { ...process.env }
  env.NODE_ENV ??= import.meta.dev ? 'development' : 'production'
  validateServerEnv(env)
})
