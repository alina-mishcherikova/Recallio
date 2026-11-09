// Security audit log (ADR 0002 §6.6, D10; OWASP A09). One JSON line per event on stdout.
// The signature restricts the fields, so a request body or an arbitrary object can't be logged by
// mistake. Never logged: passwords, hashes, cookies, session ids, tokens, bodies, headers, stacks,
// or error messages. Emails are written only as a keyed hash.
import { createHmac } from 'node:crypto'
import type { H3Event } from 'h3'

export type AuditEventName =
  | 'auth.register.success'
  | 'auth.register.failure'
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.session.invalid'
  | 'auth.rate_limited'
  | 'access.denied'
  | 'account.deleted'
  | 'account.delete.failure'
  | 'collection.deleted'
  | 'server.error'

export type AuditReason =
  | 'invalid_credentials'
  | 'unknown_user'
  | 'duplicate_email'
  | 'policy'
  | 'validation'
  | 'expired'
  | 'idle'
  | 'revoked'
  | 'user_missing'
  | 'unauthenticated'
  | 'not_owner'
  | 'origin'
  | 'rate_limit'
  | 'malformed'

export type AuditResource = 'account' | 'session' | 'collection' | 'entry' | 'card' | 'answer' | 'attempt'

export interface AuditFields {
  userId?: string
  /** Hashed inside audit(), never written in clear. */
  email?: string
  reason?: AuditReason
  scope?: 'ip' | 'account' | 'register' | 'reauth' | 'current' | 'all'
  resource?: AuditResource
  statusCode?: number
  errorName?: string
  pgCode?: string
}

const LEVELS: Record<AuditEventName, 'info' | 'warn' | 'error'> = {
  'auth.register.success': 'info',
  'auth.register.failure': 'warn',
  'auth.login.success': 'info',
  'auth.login.failure': 'warn',
  'auth.logout': 'info',
  'auth.session.invalid': 'warn',
  'auth.rate_limited': 'warn',
  'access.denied': 'warn',
  'account.deleted': 'info',
  'account.delete.failure': 'warn',
  'collection.deleted': 'info',
  'server.error': 'error',
}

let auditKey: Uint8Array | undefined

/** Set once at boot (server/plugins/04.auth-boot.ts) from `deriveSecret('recallio:audit')`. */
export function setAuditKey(key: Uint8Array | undefined): void {
  auditKey = key
}

/** First 16 hex characters of HMAC-SHA256(key, email). Null until the key is loaded (fail safe: no email). */
export function hashEmailForAudit(email: string): string | null {
  if (!auditKey) return null
  return createHmac('sha256', auditKey).update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

type Writer = (line: string) => void
let writer: Writer = (line) => {
  process.stdout.write(line)
}

/** Test seam: capture lines instead of writing to stdout. Returns the previous writer. */
export function setAuditWriter(next: Writer): Writer {
  const previous = writer
  writer = next
  return previous
}

type AuditableEvent = Pick<H3Event, 'method' | 'path'> & {
  context: { requestId?: string; clientIp?: string; auth?: { userId: string } }
}

export function audit(event: AuditableEvent, name: AuditEventName, fields: AuditFields = {}): void {
  const pathname = (event.path ?? '').split('?')[0]!.slice(0, 256)
  const record = {
    ts: new Date().toISOString(),
    level: LEVELS[name],
    event: name,
    requestId: event.context.requestId ?? null,
    route: `${event.method} ${pathname}`,
    ip: event.context.clientIp ?? null,
    userId: fields.userId ?? event.context.auth?.userId ?? null,
    ...(fields.email !== undefined && { emailHash: hashEmailForAudit(fields.email) }),
    ...(fields.reason && { reason: fields.reason }),
    ...(fields.scope && { scope: fields.scope }),
    ...(fields.resource && { resource: fields.resource }),
    ...(fields.statusCode !== undefined && { statusCode: fields.statusCode }),
    ...(fields.errorName && { errorName: fields.errorName }),
    ...(fields.pgCode && { pgCode: fields.pgCode }),
  }
  // JSON.stringify escapes newlines and control characters: no log injection.
  writer(`${JSON.stringify(record)}\n`)
}

/** Binds audit() to one request, for services that must not see the event. */
export type AuditSink = (name: AuditEventName, fields?: AuditFields) => void
export function auditSink(event: AuditableEvent): AuditSink {
  return (name, fields) => audit(event, name, fields)
}
