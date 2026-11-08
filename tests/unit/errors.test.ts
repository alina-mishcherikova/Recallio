// U10 (ADR 0002 §6.7, D7): error mapping never leaks internals or input values.
import { createError } from 'h3'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { apiErrorSchema, registerRequestSchema } from '../../shared/schemas/auth'
import {
  errorNameOf,
  parseOrBadRequest,
  pgErrorInfo,
  publicError,
  toPublicErrorBody,
  zodIssuesToPublic,
} from '../../server/utils/errors'

describe('toPublicErrorBody', () => {
  it('maps an unknown error to a fixed 500 with no stack, url or data', () => {
    const error = Object.assign(new Error('relation "users" at /Users/x/server.ts: secret=hunter2'), {
      data: { password: 'hunter2' },
      url: 'http://internal/',
    })
    const body = toPublicErrorBody(error)
    expect(body).toEqual({ statusCode: 500, message: 'Internal Server Error' })
    expect(apiErrorSchema.parse(body)).toEqual(body)
  })

  it('ignores the message of a plain createError (only publicError carries one)', () => {
    expect(
      toPublicErrorBody(createError({ statusCode: 404, message: 'Page /evil<script> not found' })),
    ).toEqual({
      statusCode: 404,
      message: 'Not Found',
    })
    expect(toPublicErrorBody(createError({ statusCode: 418, statusMessage: 'teapot' }))).toEqual({
      statusCode: 500,
      message: 'Internal Server Error',
    })
  })

  it('keeps a publicError message, and issues only on 400', () => {
    expect(toPublicErrorBody(publicError(401, 'Email or password is incorrect.'))).toEqual({
      statusCode: 401,
      message: 'Email or password is incorrect.',
    })
    expect(toPublicErrorBody(publicError(409, 'x', [{ path: 'a', message: 'b' }]))).toEqual({
      statusCode: 409,
      message: 'x',
    })
  })

  it('maps nuxt-security errors to fixed texts', () => {
    expect(
      toPublicErrorBody(createError({ statusCode: 429, statusMessage: 'Too Many Requests' })).message,
    ).toBe('Too Many Requests')
    expect(toPublicErrorBody(createError({ statusCode: 413 })).message).toBe('Payload Too Large')
  })
})

describe('Zod issues', () => {
  it('never echo input values or submitted key names', () => {
    const secret = 'Sup3rS3cretValue'
    const input = { email: secret, password: 'short', nativeLanguage: secret, [secret]: 1 }
    const error = registerRequestSchema.safeParse(input).error!
    const issues = zodIssuesToPublic(error)
    expect(JSON.stringify(issues)).not.toContain(secret)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.find((i) => i.message === 'Unknown field.')).toBeDefined()
  })

  it('a ZodError (or one as cause) becomes a 400 with issues', () => {
    const error = z.object({ a: z.string() }).strict().safeParse({ a: 1 }).error!
    expect(toPublicErrorBody(error)).toEqual({
      statusCode: 400,
      message: 'Bad Request',
      issues: [{ path: 'a', message: 'This field is required or has the wrong type.' }],
    })
    expect(toPublicErrorBody(createError({ statusCode: 500, cause: error })).statusCode).toBe(400)
  })

  it('parseOrBadRequest throws a public 400 and runs onInvalid', () => {
    let called = false
    expect(() => parseOrBadRequest(z.object({}).strict(), { x: 1 }, () => (called = true))).toThrow()
    expect(called).toBe(true)
    try {
      parseOrBadRequest(z.object({}).strict(), { x: 1 })
    } catch (e) {
      expect(toPublicErrorBody(e)).toEqual({
        statusCode: 400,
        message: 'Bad Request',
        issues: [{ path: '', message: 'Unknown field.' }],
      })
    }
  })
})

describe('error metadata for logs', () => {
  it('unwraps the Postgres code from a Drizzle error, without its message', () => {
    const pg = Object.assign(new Error('duplicate key value (email)=(a@b.c)'), {
      name: 'PostgresError',
      code: '23505',
      constraint_name: 'users_email_key',
    })
    const drizzle = Object.assign(new Error('Failed query: insert ... params: a@b.c,$scrypt$'), {
      name: 'DrizzleQueryError',
      cause: pg,
    })
    expect(pgErrorInfo(drizzle)).toEqual({ code: '23505', constraint: 'users_email_key' })
    expect(errorNameOf(drizzle)).toBe('DrizzleQueryError')
    expect(errorNameOf(createError({ statusCode: 500, cause: pg }))).toBe('PostgresError')
    expect(errorNameOf({ name: 'bad name with spaces' })).toBe('Error')
  })
})
