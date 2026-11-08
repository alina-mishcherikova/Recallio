// Request-scoped dependencies for the auth services, and the 429 response (ADR 0002 §5.4).
import { setResponseHeader, type H3Event } from 'h3'
import { tooManyAttemptsMessage } from '../../shared/schemas/auth'
import { useDb } from '../db/client'
import type { AuthDeps } from '../services/auth/auth.service'
import { loadAuthKeys } from '../services/auth/keys'
import { useAuthLimiter } from '../services/auth/limiter'
import { auditSink } from './audit'
import { publicError } from './errors'

export async function authDeps(event: H3Event): Promise<AuthDeps> {
  const keys = await loadAuthKeys()
  return {
    db: useDb(),
    limiter: useAuthLimiter(),
    rateLimitKey: keys.rateLimit,
    clientIp: event.context.clientIp ?? 'unknown',
    audit: auditSink(event),
  }
}

/** 429 with `Retry-After` (seconds) and the shared message. */
export function rateLimited(event: H3Event, retryAfter: number): never {
  setResponseHeader(event, 'retry-after', retryAfter)
  throw publicError(429, tooManyAttemptsMessage(retryAfter))
}
