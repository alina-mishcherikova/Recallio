// Identity for protected handlers (ADR 0002 §2.4, §6.2). `event.context.auth` is the only identity
// source, set only by server/handlers/02.auth.ts after the session row was checked in the database.
import type { H3Event } from 'h3'
import { audit } from './audit'
import { publicError } from './errors'

export interface AuthContext {
  userId: string
  sessionId: string
}

declare module 'h3' {
  interface H3EventContext {
    /** Random per request (server/plugins/03.request-context.ts); never taken from the client. */
    requestId?: string
    /** Set only by server/handlers/02.auth.ts. */
    auth?: AuthContext
  }
}

/**
 * Every protected handler calls this first: `const { userId } = requireAuth(event)`. Second layer
 * behind the middleware: if a path quirk ever skipped it, the handler still answers 401.
 */
export function requireAuth(event: H3Event): AuthContext {
  const auth = event.context.auth
  if (!auth || typeof auth.userId !== 'string' || typeof auth.sessionId !== 'string') {
    audit(event, 'access.denied', { reason: 'unauthenticated' })
    throw publicError(401)
  }
  return auth
}
