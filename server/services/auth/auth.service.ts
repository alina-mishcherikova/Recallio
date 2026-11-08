// Auth flows (ADR 0002 §5.5). No `event`: handlers pass the request facts they need (client IP, an
// audit sink) and turn the result into an HTTP response. Cookie writes stay in ./session.ts.
import type { Db } from '../../db/client'
import type { AuditSink } from '../../utils/audit'
import type {
  DeleteAccountRequest,
  LoginRequest,
  LogoutRequest,
  PublicUser,
  RegisterRequest,
} from '../../../shared/schemas/auth'
import type { PasswordIssue } from '../../../shared/auth/password-policy'
import { LOGIN_IP_LIMIT, REGISTER_IP_LIMIT, accountKey, limitKeys, type AuthRateLimiter } from './rate-limit'
import { checkBlocklist, hashUserPassword, needsRehash, verifyUserPassword } from './password'
import { revokeAllSessions, revokeSession } from './session-store'
import {
  createUser,
  deleteUser,
  findCredentialsByEmail,
  findPasswordHashById,
  toPublicUser,
  updatePasswordHash,
} from './users'

export interface AuthDeps {
  db: Db
  limiter: AuthRateLimiter
  /** HMAC key for account rate-limit keys (never an email in clear). */
  rateLimitKey: Uint8Array
  clientIp: string
  audit: AuditSink
}

export type RateLimited = { ok: false; kind: 'rate_limited'; retryAfter: number }

export type LoginResult =
  { ok: true; user: PublicUser } | { ok: false; kind: 'invalid_credentials' } | RateLimited

export async function login(deps: AuthDeps, input: LoginRequest): Promise<LoginResult> {
  const { limiter, audit } = deps
  const ipKey = limitKeys.loginIp(deps.clientIp)
  const acctKey = accountKey(deps.rateLimitKey, input.email)

  // Before the lookup and the hash: a blocked attempt costs no scrypt. Both limits are checked AND
  // booked in one serialized step each, so parallel guesses can't all pass a check that is recorded
  // only after the scrypt (security review H1). A success gives the bookings back.
  const ipSlot = await limiter.reserveWindow(ipKey, LOGIN_IP_LIMIT)
  if (!ipSlot.ok) {
    audit('auth.rate_limited', { email: input.email, scope: 'ip', reason: 'rate_limit' })
    return { ok: false, kind: 'rate_limited', retryAfter: ipSlot.retryAfter }
  }
  const acctSlot = await limiter.reserveBackoff(acctKey)
  if (!acctSlot.ok) {
    await ipSlot.refund() // nothing was evaluated: a 429 is not an IP failure
    audit('auth.rate_limited', { email: input.email, scope: 'account', reason: 'rate_limit' })
    return { ok: false, kind: 'rate_limited', retryAfter: acctSlot.retryAfter }
  }

  const row = await findCredentialsByEmail(deps.db, input.email)
  // Always one scrypt: the dummy hash stands in for an unknown email.
  const ok = await verifyUserPassword(row?.passwordHash, input.password)
  if (!row || !ok) {
    // The failure is already booked on both keys.
    audit('auth.login.failure', {
      email: input.email,
      reason: row ? 'invalid_credentials' : 'unknown_user',
      ...(row && { userId: row.id }),
    })
    return { ok: false, kind: 'invalid_credentials' }
  }

  await Promise.all([limiter.resetBackoff(acctKey), ipSlot.refund()])
  if (needsRehash(row.passwordHash)) {
    await updatePasswordHash(deps.db, row.id, await hashUserPassword(input.password))
  }
  audit('auth.login.success', { userId: row.id })
  return { ok: true, user: toPublicUser(row) }
}

export type RegisterResult =
  | { ok: true; user: PublicUser }
  | { ok: false; kind: 'policy'; issues: PasswordIssue[] }
  | { ok: false; kind: 'duplicate_email' }
  | RateLimited

/** Called after Zod (shape and policy). */
export async function register(deps: AuthDeps, input: RegisterRequest): Promise<RegisterResult> {
  const { audit } = deps
  // Cheap checks first (Zod already ran): a request that fails them never creates a counter key, so
  // junk registrations can't fill the limiter store (security review M2).
  const issues = await checkBlocklist(input.password)
  if (issues.length > 0) {
    audit('auth.register.failure', { email: input.email, reason: 'policy' })
    return { ok: false, kind: 'policy', issues }
  }

  // Checked and counted in one serialized step, before the scrypt.
  const limit = await deps.limiter.consumeWindow(limitKeys.registerIp(deps.clientIp), REGISTER_IP_LIMIT)
  if (!limit.ok) {
    audit('auth.rate_limited', { email: input.email, scope: 'register', reason: 'rate_limit' })
    return { ok: false, kind: 'rate_limited', retryAfter: limit.retryAfter }
  }

  // Hash before touching the DB, on both paths, so a duplicate email costs the same (D4).
  const passwordHash = await hashUserPassword(input.password)
  const created = await createUser(deps.db, {
    email: input.email,
    passwordHash,
    nativeLanguage: input.nativeLanguage,
    timezone: input.timezone,
  })
  if (!created.ok) {
    audit('auth.register.failure', { email: input.email, reason: 'duplicate_email' })
    return { ok: false, kind: 'duplicate_email' }
  }
  audit('auth.register.success', { userId: created.user.id, email: input.email })
  return { ok: true, user: created.user }
}

export type DeleteAccountResult =
  { ok: true } | { ok: false; kind: 'wrong_password' } | { ok: false; kind: 'user_missing' } | RateLimited

/** Re-authentication with the current password, then a hard delete through the cascades. */
export async function deleteAccount(
  deps: AuthDeps,
  userId: string,
  input: DeleteAccountRequest,
): Promise<DeleteAccountResult> {
  const { limiter, audit } = deps
  const key = limitKeys.reauthUser(userId)
  // Checked and a pending failure booked in one step, before the scrypt (security review H1).
  const check = await limiter.reserveBackoff(key)
  if (!check.ok) {
    audit('auth.rate_limited', { userId, scope: 'reauth', reason: 'rate_limit' })
    return { ok: false, kind: 'rate_limited', retryAfter: check.retryAfter }
  }

  const storedHash = await findPasswordHashById(deps.db, userId)
  const ok = await verifyUserPassword(storedHash, input.password)
  if (storedHash === undefined) {
    await limiter.resetBackoff(key)
    return { ok: false, kind: 'user_missing' }
  }
  if (!ok) {
    audit('account.delete.failure', { userId, reason: 'invalid_credentials' })
    return { ok: false, kind: 'wrong_password' }
  }

  await deleteUser(deps.db, userId)
  await limiter.resetBackoff(key)
  audit('account.deleted', { userId })
  return { ok: true }
}

/** Deletes the session row(s): a replayed copy of the cookie stops working immediately. */
export async function logout(
  deps: Pick<AuthDeps, 'db' | 'audit'>,
  auth: { userId: string; sessionId: string },
  input: LogoutRequest,
): Promise<void> {
  if (input.scope === 'all') await revokeAllSessions(deps.db, auth.userId)
  else await revokeSession(deps.db, auth.userId, auth.sessionId)
  deps.audit('auth.logout', { userId: auth.userId, scope: input.scope })
}
