// Shared by playwright.config.ts, tests/e2e/global-setup.ts and the specs.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100)
// Must equal what the browser sends in `Origin` (the CSRF check compares it exactly).
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`

/** Set on the E2E server as NUXT_TRUSTED_IP_HEADER, exactly like the API suite. */
export const E2E_IP_HEADER = 'x-test-client-ip'

/** A fresh documentation-range IPv6 (2001:db8::/32) per call: its own rate-limit buckets. */
export function uniqueClientIpHeaders(): Record<string, string> {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16)
  return { [E2E_IP_HEADER]: `2001:db8:e2e:${group()}:${group()}:${group()}::1` }
}
