// CSRF (ADR 0002 §6.5, D3): every mutating request must come from our origin, and /api/** bodies
// must be JSON. With SameSite=Lax, GET routes that never change state, and no CORS, this covers
// login CSRF, cross-site form posts, text/plain "simple" requests and same-site sibling subdomains.
import { getHeader, type H3Event } from 'h3'
import { audit } from '../utils/audit'
import { DEV_APP_ORIGIN } from '../utils/env'
import { publicError } from '../utils/errors'
import { SAFE_METHODS, checkRequestOrigin, hasRequestBody, isJsonContentType } from '../utils/origin'
import { isApiPath } from '../utils/public-routes'

function appOrigin(): string {
  const configured = useRuntimeConfig().appOrigin
  if (typeof configured === 'string' && configured !== '') return configured
  return import.meta.dev ? DEV_APP_ORIGIN : '' // built servers can't boot without it (00.env.ts)
}

export default defineEventHandler((event: H3Event) => {
  if (SAFE_METHODS.has(event.method)) return

  const verdict = checkRequestOrigin({
    method: event.method,
    secFetchSite: getHeader(event, 'sec-fetch-site'),
    origin: getHeader(event, 'origin'),
    appOrigin: appOrigin(),
  })
  if (verdict === 'forbidden') {
    audit(event, 'access.denied', { reason: 'origin' })
    throw publicError(403)
  }

  if (!isApiPath(event.path)) return
  const body = hasRequestBody({
    contentLength: getHeader(event, 'content-length'),
    transferEncoding: getHeader(event, 'transfer-encoding'),
  })
  // LEX-006 adds an explicit exception here for the CSV upload route.
  if (body && !isJsonContentType(getHeader(event, 'content-type'))) throw publicError(415)
})
