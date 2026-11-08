// CSRF defense (ADR 0002 §6.5, D3): Fetch Metadata + exact Origin match + JSON-only API bodies.
// Pure functions, so every combination is unit-tested (U8).

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

export type OriginVerdict = 'ok' | 'forbidden'

/**
 * Mutating requests must come from our own origin:
 * 1. `Sec-Fetch-Site`, when present, must be `same-origin` (`same-site`, `cross-site`, `none` → 403).
 * 2. `Origin`, when present, must equal `appOrigin` exactly (`null`, other ports, a trailing slash → 403).
 * 3. Neither header → 403. Non-browser clients can send `Origin`.
 */
export function checkRequestOrigin(input: {
  method: string
  secFetchSite: string | undefined
  origin: string | undefined
  appOrigin: string
}): OriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return 'ok'
  const site = input.secFetchSite?.trim().toLowerCase()
  const origin = input.origin
  if (site === undefined && origin === undefined) return 'forbidden'
  if (site !== undefined && site !== 'same-origin') return 'forbidden'
  if (origin !== undefined && (input.appOrigin === '' || origin !== input.appOrigin)) return 'forbidden'
  return 'ok'
}

/** True when the request carries a body (by its framing headers, before it is read). */
export function hasRequestBody(headers: { contentLength?: string; transferEncoding?: string }): boolean {
  if (headers.transferEncoding !== undefined) return true
  if (headers.contentLength === undefined) return false
  return headers.contentLength.trim() !== '0'
}

/** `application/json`, optionally with parameters (`; charset=utf-8`). Nothing else. */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  return contentType.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
}
