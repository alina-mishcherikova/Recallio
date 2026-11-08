// A10, A12 (ADR 0002 §6.5, §8.3): cross-origin requests and malformed or oversized input.
import { describe, expect, it } from 'vitest'
import { apiErrorSchema } from '../../shared/schemas/auth'
import {
  Client,
  ORIGIN,
  checkNoLeaksAfterAll,
  registerAccount,
  remember,
  uniqueEmail,
} from './helpers/client'

checkNoLeaksAfterAll()

const routes = [
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/logout'],
  ['DELETE', '/api/account'],
] as const

describe('cross-origin requests are blocked (A10)', () => {
  it.each(routes)(
    '%s %s: hostile Origin and Sec-Fetch-Site → 403, even with a valid session',
    async (method, path) => {
      const client = new Client()
      const account = await registerAccount(client)
      const body = { email: account.email, password: account.password }
      const cases: Array<{ origin?: string | false; headers?: Record<string, string> }> = [
        { origin: 'https://evil.example' },
        { origin: 'null' },
        { origin: `${ORIGIN}/` },
        { headers: { 'sec-fetch-site': 'cross-site' } },
        { headers: { 'sec-fetch-site': 'same-site' } },
        { headers: { 'sec-fetch-site': 'none' } },
        { origin: false },
      ]
      for (const c of cases) {
        const res = await client.send(method, path, { json: body, ...c })
        expect(res.status, JSON.stringify(c)).toBe(403)
        expect(res.body).toEqual({ statusCode: 403, message: 'Forbidden' })
      }
      // Still signed in: nothing ran.
      expect((await client.get('/api/auth/me')).status).toBe(200)
    },
  )

  it('same-origin with Sec-Fetch-Site works', async () => {
    const client = new Client()
    const account = await registerAccount(client)
    const res = await client.post(
      '/api/auth/login',
      { email: account.email, password: account.password },
      { headers: { 'sec-fetch-site': 'same-origin' } },
    )
    expect(res.status).toBe(200)
  })

  it.each([
    ['text/plain', 'text/plain'],
    ['form', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
  ])('%s bodies → 415', async (_label, type) => {
    const res = await new Client().post('/api/auth/login', undefined, {
      body: JSON.stringify({ email: uniqueEmail(), password: 'x' }),
      headers: { 'content-type': type },
    })
    expect(res.status).toBe(415)
    expect(res.body).toEqual({ statusCode: 415, message: 'Unsupported Media Type' })
  })

  it('DELETE /api/_auth/session → 404, and the session survives', async () => {
    const client = new Client()
    await registerAccount(client)
    const res = await client.delete('/api/_auth/session')
    expect(res.status).toBe(404)
    expect(res.setCookies).toEqual([])
    expect((await client.get('/api/auth/me')).status).toBe(200)
  })
})

describe('malformed and oversized input (A12)', () => {
  const probe = 'Zq7-probe-value-never-echoed'
  remember(probe)

  const cases: Array<[string, string, string, number]> = [
    [
      '1.1 MB body',
      '/api/auth/login',
      JSON.stringify({ email: 'a@b.cd', password: 'x'.repeat(1_100_000) }),
      413,
    ],
    ['invalid JSON', '/api/auth/login', `{"email": "${probe}`, 400],
    ['JSON array', '/api/auth/login', JSON.stringify([probe]), 400],
    ['JSON string', '/api/auth/login', JSON.stringify(probe), 400],
    [
      '255-character email',
      '/api/auth/login',
      JSON.stringify({ email: `${probe}${'a'.repeat(220)}@example.test`, password: 'x' }),
      400,
    ],
    [
      '1025-unit password at login',
      '/api/auth/login',
      JSON.stringify({ email: 'a@b.cd', password: probe.padEnd(1025, 'x') }),
      400,
    ],
    [
      '129-code-point password at register',
      '/api/auth/register',
      JSON.stringify({
        email: 'long@example.test',
        password: `${probe} `.padEnd(129, 'é'),
        nativeLanguage: 'en',
      }),
      400,
    ],
    ['unknown key', '/api/auth/login', JSON.stringify({ email: 'a@b.cd', password: 'x', [probe]: 1 }), 400],
    [
      'wrong types',
      '/api/auth/register',
      JSON.stringify({ email: 1, password: [probe], nativeLanguage: { x: probe } }),
      400,
    ],
    [
      'prototype keys',
      '/api/auth/login',
      `{"email":"a@b.cd","password":"x","__proto__":{"admin":true}}`,
      400,
    ],
  ]

  it.each(cases)(
    '%s → %i, body matches apiErrorSchema and echoes nothing',
    async (_label, path, body, status) => {
      const res = await new Client().post(path, undefined, {
        body,
        headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(status)
      const parsed = apiErrorSchema.parse(res.body)
      expect(res.text).not.toContain(probe)
      if (status === 400 && path.endsWith('register') && _label.startsWith('129')) {
        expect(parsed.issues).toContainEqual({ path: 'password', message: 'Use at most 128 characters.' })
      }
    },
  )

  it('a non-empty query on GET /api/auth/me → 400 (strict)', async () => {
    const client = new Client()
    await registerAccount(client)
    const res = await client.get(`/api/auth/me?${probe}=1`)
    expect(res.status).toBe(400)
    expect(res.text).not.toContain(probe)
  })
})
