// Central JSON error handler (ADR 0002 §6.7; OWASP A10). Prepended to Nitro's chain in nuxt.config.ts.
// Bodies are exactly `{ statusCode, message, issues? }`: no stack, URL, host, data or statusMessage
// reflection. Headers set before the error (Retry-After, Set-Cookie, X-Request-Id) are kept.
//
// Handled here: every /api/** error, every error on /__nuxt_error, and every other error that would
// get a JSON body (same test as Nuxt's own handler: no `text/html` in Accept, and a JSON Accept, a CLI
// user agent, a CORS fetch, or a `.json` path). Nuxt's JSON body would reflect the request URL and
// a client-chosen Host (security review L2). HTML page errors still go to Nuxt (app/error.vue).
import { getRequestHeader, send, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import { audit } from './utils/audit'
import {
  STATUS_MESSAGES,
  errorNameOf,
  pgErrorInfo,
  toPublicErrorBody,
  type PublicStatus,
} from './utils/errors'
import { isApiPath, normalizeApiPath } from './utils/public-routes'

const header = (event: H3Event, name: string) => (getRequestHeader(event, name) ?? '').toLowerCase()

/** Mirrors @nuxt/nitro-server's isJsonRequest (minus the /api/ rule, handled separately). */
function wouldAnswerJson(event: H3Event): boolean {
  if (header(event, 'accept').includes('text/html')) return false
  const pathname = event.path.split('?', 1)[0]!
  return (
    header(event, 'accept').includes('application/json') ||
    header(event, 'user-agent').includes('curl/') ||
    header(event, 'user-agent').includes('httpie/') ||
    header(event, 'sec-fetch-mode').includes('cors') ||
    pathname.endsWith('.json')
  )
}

export default defineNitroErrorHandler((error, event) => {
  const handled =
    isApiPath(event.path) || normalizeApiPath(event.path) === '/__nuxt_error' || wouldAnswerJson(event)
  if (!handled) return
  const body = toPublicErrorBody(error)
  if (body.statusCode >= 500) {
    audit(event, 'server.error', {
      statusCode: body.statusCode,
      errorName: errorNameOf(error),
      pgCode: pgErrorInfo(error).code,
    })
  }
  setResponseStatus(event, body.statusCode, STATUS_MESSAGES[body.statusCode as PublicStatus | 500])
  setResponseHeader(event, 'content-type', 'application/json')
  setResponseHeader(event, 'cache-control', 'no-store')
  return send(event, JSON.stringify(body))
})
