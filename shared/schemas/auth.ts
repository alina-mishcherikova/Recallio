// Auth request/response contracts (ADR 0002 §2.1, §2.2). Shared by the server handlers and the UI.
// Every request schema is `.strict()`: unknown keys (for example a `userId`) are rejected.
import { z } from '../zod'
import { LANGUAGE_CODES, languageCodeSchema } from '../constants/languages'
import { PASSWORD_INPUT_MAX, checkPasswordShape, normalizePassword } from '../auth/password-policy'

export { PASSWORD_MESSAGES, PASSWORD_MIN, PASSWORD_MAX, PASSWORD_INPUT_MAX } from '../auth/password-policy'

/** Fixed, user-facing messages for auth errors. The server sends exactly these strings. */
export const AUTH_MESSAGES = Object.freeze({
  invalidEmail: 'Enter a valid email address.',
  passwordRequired: 'Enter your password.',
  invalidTimezone: 'Choose a valid time zone.',
  /** Missing or unsupported `nativeLanguage` at registration. */
  nativeLanguage: 'Choose your native language.',
  /** 401 on login: the same text for an unknown email and a wrong password. */
  invalidCredentials: 'Email or password is incorrect.',
  /** 409 on register (D4). */
  emailTaken: 'Could not create an account with this email. If you already have one, log in.',
  /** 403 on account deletion (wrong current password). */
  wrongPassword: 'Password is incorrect.',
  /** 401 on any protected route without a valid session. */
  unauthorized: 'Unauthorized',
})

/** 429 message for every auth limiter. `retryAfterSeconds` comes from the `Retry-After` header. */
export function tooManyAttemptsMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
}

/** IANA zone names only (`Europe/Paris`, `America/Argentina/Salta`, `UTC`), known to the runtime. */
export function isSupportedTimeZone(value: string): boolean {
  const segments = value.split('/')
  if (segments.length > 3 || !/^[A-Za-z]/.test(value)) return false
  if (!segments.every((segment) => /^[A-Za-z0-9_+-]+$/.test(segment))) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const emailFormat = z.email()

/** 3–254 characters, local part at most 64, and Zod's (ASCII) email format. */
function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false
  if (email.split('@')[0]!.length > 64) return false
  return emailFormat.safeParse(email).success
}

/**
 * Trim, lowercase, then validate. Stored in a citext column, so case never creates duplicates.
 * One check after normalization, so any invalid email (including an empty or blank one) yields
 * exactly one issue.
 */
export const emailSchema = z
  .string({ error: AUTH_MESSAGES.invalidEmail })
  .max(320, { error: AUTH_MESSAGES.invalidEmail, abort: true }) // input bound before trimming
  .trim()
  .toLowerCase()
  .refine(isValidEmail, AUTH_MESSAGES.invalidEmail)

/** NFKC-normalized (NIST 800-63B). Used for login and re-authentication: no policy, only bounds. */
export const passwordInputSchema = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .min(1, AUTH_MESSAGES.passwordRequired)
  .max(PASSWORD_INPUT_MAX, AUTH_MESSAGES.passwordRequired) // a DoS bound, not the policy
  .transform(normalizePassword)

/** IANA time zone, checked against Intl. Optional at registration, default 'UTC'. */
export const timezoneSchema = z
  .string({ error: AUTH_MESSAGES.invalidTimezone })
  .min(1, AUTH_MESSAGES.invalidTimezone)
  .max(64, AUTH_MESSAGES.invalidTimezone)
  .refine(isSupportedTimeZone, AUTH_MESSAGES.invalidTimezone)

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordInputSchema,
    nativeLanguage: z.enum(LANGUAGE_CODES, { error: AUTH_MESSAGES.nativeLanguage }), // 'fr' | 'en'
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .superRefine(
    (v, ctx) => {
      // Length 12–128 code points, no single-character or simple-sequence passwords, must not contain
      // the email local part (3+ characters) or the service name. The blocklist is server-only.
      const email = typeof v.email === 'string' && isValidEmail(v.email) ? v.email : undefined
      for (const issue of checkPasswordShape(v.password, { email }))
        ctx.addIssue({ code: 'custom', path: ['password'], message: issue.message })
    },
    {
      // Run even when other fields are invalid, so one submit reports every problem. Only the
      // password itself must have parsed (it is then a normalized string).
      when: (payload) =>
        typeof (payload.value as { password?: unknown } | undefined)?.password === 'string' &&
        !payload.issues.some((issue) => issue.path?.[0] === 'password'),
    },
  )
export type RegisterRequest = z.infer<typeof registerRequestSchema>

export const loginRequestSchema = z.object({ email: emailSchema, password: passwordInputSchema }).strict()
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const logoutRequestSchema = z
  .object({ scope: z.enum(['current', 'all']).default('current') })
  .strict()
  .default({ scope: 'current' }) // an empty body is allowed
export type LogoutRequest = z.infer<typeof logoutRequestSchema>

export const deleteAccountRequestSchema = z.object({ password: passwordInputSchema }).strict()
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>

/** The only user shape that ever leaves the server. Built field by field, never by spreading a row. */
export const publicUserSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    nativeLanguage: languageCodeSchema,
    timezone: z.string(),
    dailyNewLimit: z.number().int(),
    dailyReviewLimit: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export type PublicUser = z.infer<typeof publicUserSchema>

export const authUserResponseSchema = z.object({ user: publicUserSchema }).strict()
export type AuthUserResponse = z.infer<typeof authUserResponseSchema>

/** Error body for every /api/** error (§6.7). `issues` only on 400, with fixed messages (D7). */
export const apiErrorSchema = z
  .object({
    statusCode: z.number().int(),
    message: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .max(20)
      .optional(),
  })
  .strict()
export type ApiError = z.infer<typeof apiErrorSchema>
