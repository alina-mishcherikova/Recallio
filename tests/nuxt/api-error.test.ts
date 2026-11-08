// Only fixed, user-facing messages reach the screen (ADR 0002 §6.7, §7).
import { describe, expect, it } from 'vitest'
import { AUTH_MESSAGES } from '#shared/schemas/auth'
import {
  CHECK_FORM_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  toUiApiError,
} from '~/utils/api-error'

function fetchError(status: number, data: unknown, headers: Record<string, string> = {}) {
  return { statusCode: status, data, response: { status, headers: new Headers(headers) } }
}

describe('toUiApiError', () => {
  it('passes through route-specific messages', () => {
    expect(
      toUiApiError(fetchError(401, { statusCode: 401, message: AUTH_MESSAGES.invalidCredentials })).message,
    ).toBe(AUTH_MESSAGES.invalidCredentials)
    expect(
      toUiApiError(fetchError(409, { statusCode: 409, message: AUTH_MESSAGES.emailTaken })).message,
    ).toBe(AUTH_MESSAGES.emailTaken)
    expect(
      toUiApiError(fetchError(403, { statusCode: 403, message: AUTH_MESSAGES.wrongPassword })).message,
    ).toBe(AUTH_MESSAGES.wrongPassword)
  })

  it('keeps 400 issues and replaces the bare reason phrase', () => {
    const result = toUiApiError(
      fetchError(400, { statusCode: 400, message: 'Bad Request', issues: [{ path: 'email', message: 'x' }] }),
    )
    expect(result).toEqual({
      status: 400,
      message: CHECK_FORM_MESSAGE,
      issues: [{ path: 'email', message: 'x' }],
    })
  })

  it('never shows 5xx text, non-API bodies, or bare reason phrases', () => {
    expect(
      toUiApiError(fetchError(500, { statusCode: 500, message: 'connect ECONNREFUSED 10.0.0.5:5432' }))
        .message,
    ).toBe(GENERIC_ERROR_MESSAGE)
    expect(toUiApiError(fetchError(502, '<html>Bad gateway</html>')).message).toBe(GENERIC_ERROR_MESSAGE)
    expect(toUiApiError(fetchError(403, { statusCode: 403, message: 'Forbidden' })).message).toBe(
      GENERIC_ERROR_MESSAGE,
    )
    expect(
      toUiApiError(fetchError(401, { statusCode: 401, message: 'Unauthorized', stack: 'x' })).message,
    ).toBe(GENERIC_ERROR_MESSAGE)
  })

  it('builds the 429 text from Retry-After when the body is not ours', () => {
    expect(toUiApiError(fetchError(429, 'Too Many Requests', { 'retry-after': '90' })).message).toBe(
      'Too many attempts. Try again in 2 minutes.',
    )
    expect(
      toUiApiError(
        fetchError(429, { statusCode: 429, message: 'Too many attempts. Try again in 5 minutes.' }),
      ).message,
    ).toBe('Too many attempts. Try again in 5 minutes.')
  })

  it('reports network failures and unknown throwables as a connection problem', () => {
    expect(toUiApiError(new TypeError('Failed to fetch')).message).toBe(NETWORK_ERROR_MESSAGE)
    expect(toUiApiError({ statusCode: 0, response: undefined }).message).toBe(NETWORK_ERROR_MESSAGE)
  })
})
