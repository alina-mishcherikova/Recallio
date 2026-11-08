// Safe error responses for /api/** (ADR 0002 §6.7, D7; OWASP A10).
// Only errors created by `publicError()` carry a route-specific message. Everything else gets a fixed
// text per status. Issue messages are whitelisted, so a submitted value can never be echoed.
import { createError, isError, type H3Error } from 'h3'
import { ZodError, type z } from '../../shared/zod'
import { LANGUAGE_MESSAGE } from '../../shared/constants/languages'
import { AUTH_MESSAGES, PASSWORD_MESSAGES, type ApiError } from '../../shared/schemas/auth'

export const PUBLIC_STATUSES = [400, 401, 403, 404, 405, 409, 413, 415, 429, 503] as const
export type PublicStatus = (typeof PUBLIC_STATUSES)[number]

export const STATUS_MESSAGES: Readonly<Record<PublicStatus | 500, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
})

export interface PublicIssue {
  path: string
  message: string
}

const PUBLIC = Symbol('recallio.publicError')
const MAX_ISSUES = 20

interface PublicMark {
  message: string
  issues?: PublicIssue[]
}

type MarkedError = H3Error & { [PUBLIC]?: PublicMark }

/** An HTTP error whose message is safe to show (a fixed string chosen by the route). */
export function publicError(statusCode: PublicStatus, message?: string, issues?: PublicIssue[]): H3Error {
  const text = message ?? STATUS_MESSAGES[statusCode]
  const error = createError({
    statusCode,
    statusMessage: STATUS_MESSAGES[statusCode],
    message: text,
  }) as MarkedError
  error[PUBLIC] = {
    message: text,
    ...(issues && statusCode === 400 && { issues: issues.slice(0, MAX_ISSUES) }),
  }
  return error
}

// Messages that our schemas set on purpose. Any other message (Zod defaults) is replaced: some of
// them name the submitted key (`unrecognized_keys`) or the received type.
const KNOWN_MESSAGES = new Set<string>([
  ...Object.values(AUTH_MESSAGES),
  ...Object.values(PASSWORD_MESSAGES),
  LANGUAGE_MESSAGE,
])

const CODE_MESSAGES: Record<string, string> = {
  invalid_type: 'This field is required or has the wrong type.',
  unrecognized_keys: 'Unknown field.',
  invalid_value: 'Choose one of the allowed values.',
  too_small: 'This value is too short.',
  too_big: 'This value is too long.',
}

function safeSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') return String(segment)
  if (typeof segment === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(segment)) return segment
  return '?'
}

/** Zod issues → `{ path, message }`, never including input values or submitted key names. */
export function zodIssuesToPublic(error: ZodError): PublicIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(safeSegment).join('.'),
    message: KNOWN_MESSAGES.has(issue.message)
      ? issue.message
      : (CODE_MESSAGES[issue.code] ?? 'Invalid value.'),
  }))
}

/** Parses `input` or throws a 400 with public issues. `onInvalid` runs first (for example to audit). */
export function parseOrBadRequest<S extends z.ZodType>(
  schema: S,
  input: unknown,
  onInvalid?: () => void,
): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    onInvalid?.()
    throw publicError(400, STATUS_MESSAGES[400], zodIssuesToPublic(result.error))
  }
  return result.data
}

function statusOf(error: unknown): number {
  const e = error as { statusCode?: unknown; status?: unknown } | null
  const raw =
    typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : 500
  return raw
}

function findZodError(error: unknown): ZodError | undefined {
  if (error instanceof ZodError) return error
  const cause = (error as { cause?: unknown } | null)?.cause
  return cause instanceof ZodError ? cause : undefined
}

/** The only body any /api/** error ever has. Unknown or internal errors become a fixed 500. */
export function toPublicErrorBody(error: unknown): ApiError {
  const zod = findZodError(error)
  if (zod) return { statusCode: 400, message: STATUS_MESSAGES[400], issues: zodIssuesToPublic(zod) }

  const raw = statusOf(error)
  const status = (PUBLIC_STATUSES as readonly number[]).includes(raw) ? (raw as PublicStatus) : 500
  const mark = (error as MarkedError | null)?.[PUBLIC]
  if (mark && status !== 500) {
    return { statusCode: status, message: mark.message, ...(mark.issues && { issues: mark.issues }) }
  }
  return { statusCode: status, message: STATUS_MESSAGES[status] }
}

/** Postgres SQLSTATE and constraint, unwrapping Drizzle's `DrizzleQueryError` (whose message holds params). */
export function pgErrorInfo(error: unknown): { code?: string; constraint?: string } {
  for (let e = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const candidate = e as { code?: unknown; constraint_name?: unknown; name?: unknown }
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint_name === 'string' ? candidate.constraint_name : undefined,
      }
    }
  }
  return {}
}

/** The error's constructor name only: never its message (it may contain values). */
export function errorNameOf(error: unknown): string {
  let e = error
  // h3 wraps thrown errors; the cause is the interesting one.
  if (isError(e) && e.cause) e = e.cause
  const name = (e as { name?: unknown } | null)?.name
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error'
}
