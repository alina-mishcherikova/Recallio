// A small cookie-jar client for the API black-box tests (ADR 0002 §8.3). Sends `Origin` on
// mutating requests, a per-client IP in the trusted header, and records every response so each
// file can prove that no password, hash or secret was ever returned or logged (A13).
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, inject } from 'vitest'

export const SESSION_COOKIE = '__Host-recallio-session'
export const IP_HEADER = 'x-test-client-ip'

const { origin, logFile } = inject('api')
export const ORIGIN = origin

// Unique documentation-range IPv6 addresses: one /64 per client (the server counts per-IP limits per
// /64), with a random third hextet per file, so rate-limit buckets never collide across files.
const fileTag = randomBytes(2).toString('hex')
let ipCounter = 0
export function nextIp(): string {
  ipCounter++
  if (ipCounter > 0xffff) throw new Error('nextIp(): more than 65,535 clients in one file')
  return `2001:db8:${fileTag}:${ipCounter.toString(16)}::1`
}

const secrets = new Set<string>()
/** Values that must never appear in the server log (passwords, emails, cookies). */
export function remember(...values: string[]) {
  for (const v of values) if (v) secrets.add(v)
}

const responseBodies: unknown[] = []

export interface ApiResponse {
  status: number
  headers: Headers
  text: string
  body: unknown
  setCookies: string[]
  requestId: string | null
}

export interface SendOptions {
  json?: unknown
  body?: string
  headers?: Record<string, string>
  /** `false` omits Origin; a string overrides it. Default: our origin on mutating methods. */
  origin?: string | false
  /** `false` sends no cookie for this request; a string sends exactly that Cookie header. */
  cookie?: string | false
  ip?: string
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export class Client {
  cookie: string | undefined
  constructor(public ip: string = nextIp()) {}

  async send(method: string, path: string, opts: SendOptions = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { [IP_HEADER]: opts.ip ?? this.ip, ...opts.headers }
    if (opts.origin !== false && !SAFE.has(method) && !('origin' in headers)) {
      headers.origin = typeof opts.origin === 'string' ? opts.origin : ORIGIN
    }
    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['content-type'] ??= 'application/json'
    }
    if (opts.cookie !== false) {
      const cookie =
        typeof opts.cookie === 'string' ? opts.cookie : this.cookie && `${SESSION_COOKIE}=${this.cookie}`
      if (cookie) headers.cookie = cookie
    }
    const res = await fetch(ORIGIN + path, { method, headers, body, redirect: 'manual' })
    const text = await res.text()
    const setCookies = res.headers.getSetCookie()
    for (const c of setCookies) {
      if (!c.startsWith(`${SESSION_COOKIE}=`)) continue
      const value = c.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!
      if (/max-age=0/i.test(c) || value === '') this.cookie = undefined
      else {
        this.cookie = value
        remember(value)
      }
    }
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    responseBodies.push(parsed)
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: parsed,
      setCookies,
      requestId: res.headers.get('x-request-id'),
    }
  }

  get(path: string, opts?: SendOptions) {
    return this.send('GET', path, opts)
  }
  post(path: string, json?: unknown, opts?: SendOptions) {
    return this.send('POST', path, { ...opts, ...(json !== undefined && { json }) })
  }
  patch(path: string, json?: unknown, opts?: SendOptions) {
    return this.send('PATCH', path, { ...opts, ...(json !== undefined && { json }) })
  }
  delete(path: string, json?: unknown, opts?: SendOptions) {
    return this.send('DELETE', path, { ...opts, ...(json !== undefined && { json }) })
  }
}

export function uniqueEmail(prefix = 'user'): string {
  const email = `${prefix}-${randomUUID().slice(0, 12)}@example.test`
  remember(email)
  return email
}

export function uniquePassword(): string {
  const password = `pw ${randomUUID()} Zebra!`
  remember(password)
  return password
}

export interface Account {
  email: string
  password: string
  userId: string
}

/** Registers (201 expected) and leaves the client signed in. */
export async function registerAccount(
  client: Client,
  o: { email?: string; password?: string } = {},
): Promise<Account> {
  const email = o.email ?? uniqueEmail()
  const password = o.password ?? uniquePassword()
  remember(email, password)
  const res = await client.post('/api/auth/register', { email, password, nativeLanguage: 'en' })
  expect(res.status, res.text).toBe(201)
  return { email, password, userId: (res.body as { user: { id: string } }).user.id }
}

/** The server log so far (stdout + stderr of the built server). */
export function readServerLog(): string {
  return readFileSync(logFile, 'utf8')
}

export function auditLines(): Record<string, unknown>[] {
  return readServerLog()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/** Polls the log until `predicate` matches a line (stdout is flushed asynchronously). */
export async function waitForAudit(predicate: (line: Record<string, unknown>) => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = auditLines().find(predicate)
    if (found) return found
    if (Date.now() > deadline) throw new Error('expected audit line not found')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const FORBIDDEN_KEYS = /^(password|passwordhash|password_hash|secure|sid)$/i

/** Paths of keys that must never appear in a response body. */
export function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEYS.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeys(v, `${path}.${k}`),
    ])
  }
  return []
}

/** A13: registered once per file. Runs after the file's tests. */
export function checkNoLeaksAfterAll() {
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300)) // let the server flush stdout
    const log = readServerLog()
    expect(log).not.toContain('$scrypt$')
    for (const secret of secrets) {
      if (log.includes(secret)) throw new Error('a password, email or cookie value appears in the server log')
    }
    for (const body of responseBodies) expect(forbiddenKeys(body)).toEqual([])
    for (const body of responseBodies) {
      const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
      expect(text).not.toContain('$scrypt$')
      for (const secret of secrets) {
        // Emails are returned to their owner by design ({ user: { email } }); passwords and cookies never.
        if (secret.includes('@')) continue
        if (text.includes(secret)) throw new Error('a password or cookie value appears in a response body')
      }
    }
  })
}
