// A random id per request (ADR 0002 §3), for X-Request-Id and the audit log. Never taken from the
// client, so a caller can't forge or link log lines. Runs after 01.client-ip's request hook.
import { randomUUID } from 'node:crypto'
import { setResponseHeader } from 'h3'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const requestId = randomUUID()
    event.context.requestId = requestId
    setResponseHeader(event, 'x-request-id', requestId)
  })
})
