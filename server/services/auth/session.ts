// Session cookie glue (ADR 0002 §4, §6.3). With server/handlers/02.auth.ts, the only module allowed
// to call nuxt-auth-utils' session functions (lint rule). Reading never creates a cookie for an
// anonymous visitor, and the session is written only at login/registration, so the 30-day TTL can
// never be extended.
import type { H3Event } from 'h3'
import { getCookie } from 'h3'
import type { Db } from '../../db/client'
import { createSession } from './session-store'

export type PresentedSession =
  { kind: 'none' } | { kind: 'malformed' } | { kind: 'present'; userId: string; sid: string }

function sessionCookieName(): string {
  const name = (useRuntimeConfig().session as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name ? name : '__Host-recallio-session'
}

/** Checks for the cookie first: `getUserSession()` alone would seal an empty session into the response. */
export async function readPresentedSession(event: H3Event): Promise<PresentedSession> {
  if (!getCookie(event, sessionCookieName())) return { kind: 'none' }
  const session = await getUserSession(event)
  const userId = session.user?.id
  const sid = session.secure?.sid
  if (typeof userId !== 'string' || typeof sid !== 'string') return { kind: 'malformed' }
  return { kind: 'present', userId, sid }
}

/**
 * Rotation on login and registration (§4.4): delete the row of any session presented with the
 * request, insert a new row, then a new nuxt session id (`clear`) with the new data (`replace`).
 * The response carries exactly one Set-Cookie for the session.
 */
export async function startSession(event: H3Event, db: Db, userId: string): Promise<void> {
  const sid = await createSession(db, userId, { replaceSessionId: event.context.auth?.sessionId })
  await clearUserSession(event)
  await replaceUserSession(event, { user: { id: userId }, secure: { sid, loggedInAt: Date.now() } })
  event.context.auth = { userId, sessionId: sid }
}

/** Expires the cookie. The caller deletes the session row first (logout) or it is already invalid. */
export async function endSession(event: H3Event): Promise<void> {
  await clearUserSession(event)
  event.context.auth = undefined
}
