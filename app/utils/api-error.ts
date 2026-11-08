// Maps a failed `$fetch` call to text that is safe to show (ADR 0002 §2.2, §6.7, §7).
// The UI only ever shows the server's fixed messages (validated against `apiErrorSchema`) or its own
// fixed fallbacks. Raw error objects, stack traces and non-API bodies are never rendered.
import { z } from '#shared/zod'
import { apiErrorSchema, tooManyAttemptsMessage } from '#shared/schemas/auth'

/** Statuses whose server message is meant for the user. Everything else gets a fixed fallback. */
const USER_FACING_STATUSES = new Set([400, 401, 403, 409, 429])

export const NETWORK_ERROR_MESSAGE = "We couldn't reach the server. Check your connection and try again."
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again in a moment.'
export const CHECK_FORM_MESSAGE = 'Check the form and try again.'

const REASON_PHRASES = new Set(['Bad Request', 'Unauthorized', 'Forbidden', 'Conflict', 'Too Many Requests'])

// Same shape as the contract, but tolerant of extra keys, so a harmless server addition doesn't
// turn every fixed message into the generic fallback.
const errorBodySchema = z.object({
  ...apiErrorSchema.shape,
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .max(20)
    .optional(),
})

export interface UiApiError {
  /** HTTP status, or 0 when the request never got a response. */
  status: number
  /** Safe, user-facing text. */
  message: string
  /** Field errors from a 400 (`path` is the field name). */
  issues: { path: string; message: string }[]
}

interface FetchErrorLike {
  status?: number
  statusCode?: number
  data?: unknown
  response?: { status?: number; headers?: Headers }
}

function isFetchErrorLike(value: unknown): value is FetchErrorLike {
  return typeof value === 'object' && value !== null && ('response' in value || 'statusCode' in value)
}

/** Parses a delta-seconds `Retry-After`. HTTP dates are ignored (the server sends seconds). */
function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (!raw || !/^\d{1,7}$/.test(raw)) return undefined
  return Number(raw)
}

export function toUiApiError(error: unknown): UiApiError {
  if (!isFetchErrorLike(error)) return { status: 0, message: NETWORK_ERROR_MESSAGE, issues: [] }
  const status = error.response?.status ?? error.statusCode ?? error.status ?? 0
  if (status === 0) return { status: 0, message: NETWORK_ERROR_MESSAGE, issues: [] }

  const body = errorBodySchema.safeParse(error.data)
  if (status === 429) {
    // Prefer the auth limiter's text; rebuild it from Retry-After for the global limiter or a proxy.
    const seconds = retryAfterSeconds(error.response?.headers)
    const message =
      body.success && !REASON_PHRASES.has(body.data.message)
        ? body.data.message
        : tooManyAttemptsMessage(seconds ?? 60 * 15)
    return { status, message, issues: [] }
  }
  if (!body.success || !USER_FACING_STATUSES.has(status)) {
    return { status, message: GENERIC_ERROR_MESSAGE, issues: [] }
  }
  const issues = status === 400 ? (body.data.issues ?? []) : []
  // A bare reason phrase ("Bad Request", "Forbidden" from the origin check, ...) isn't written for
  // people. Route-specific messages (401 login, 403 password, 409, 429) are.
  const message = REASON_PHRASES.has(body.data.message)
    ? status === 400
      ? CHECK_FORM_MESSAGE
      : GENERIC_ERROR_MESSAGE
    : body.data.message
  return { status, message, issues }
}
