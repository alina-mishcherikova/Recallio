// Black-box security checks against the built server (OWASP A02/A05/A06/A10).
// Converted from the LEX-001 security review. Runs on the desktop project only.
import { expect, test } from '@playwright/test'
import { uniqueClientIpHeaders } from './env'

function directives(csp: string) {
  return Object.fromEntries(
    csp
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, ...values] = s.split(/\s+/)
        return [name, values]
      }),
  ) as Record<string, string[]>
}

test.describe('CSP on the SSR document', () => {
  test('uses a fresh per-request nonce on every script and style tag', async ({ request }) => {
    const nonces: string[] = []
    for (let i = 0; i < 2; i++) {
      const res = await request.get('/')
      const nonce = res.headers()['content-security-policy']?.match(/'nonce-([A-Za-z0-9+/=_-]{16,})'/)?.[1]
      expect(nonce).toBeDefined()
      nonces.push(nonce!)
      const html = await res.text()
      const tags = html.match(/<(script|style)\b[^>]*>/g) ?? []
      expect(tags.length).toBeGreaterThan(0)
      for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`)
      expect(html).not.toMatch(/\son[a-z]+\s*=/i) // no inline event handlers
    }
    expect(nonces[0]).not.toBe(nonces[1])
  })

  test('has no unsafe sources and locks down framing, base and objects', async ({ request }) => {
    const csp = directives((await request.get('/')).headers()['content-security-policy'] ?? '')
    for (const d of ['script-src', 'style-src']) {
      expect(csp[d]).not.toContain("'unsafe-inline'")
      expect(csp[d]).not.toContain("'unsafe-eval'")
    }
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['script-src-attr']).toEqual(["'none'"])
  })

  test('the page renders with no CSP violations', async ({ page }) => {
    const violations: string[] = []
    page.on('console', (msg) => {
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text())
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(violations).toEqual([])
  })
})

test.describe('/api/health', () => {
  test('returns only status fields and no fingerprinting headers', async ({ request }) => {
    const res = await request.get('/api/health')
    expect([200, 503]).toContain(res.status())
    expect(Object.keys(await res.json()).sort()).toEqual(['database', 'status'])
    const h = res.headers()
    expect(h['x-powered-by']).toBeUndefined()
    expect(h['server']).toBeUndefined()
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['cache-control']).toBe('no-store')
  })

  test('rejects bodies over 1 MB with 413', async ({ request }) => {
    const res = await request.post('/api/health', {
      headers: { 'content-type': 'application/json' },
      data: 'a'.repeat(1_100_000),
    })
    expect(res.status()).toBe(413)
  })
})

const LEAK = /stack|node_modules|\.output|\/Users\/|at \w+ \(/

// ADR 0002 §6.2 item 5: deny by default before routing, so anonymous callers can't map the API.
test('unknown API routes return 401 to anonymous callers, without stack traces or file paths', async ({
  request,
}) => {
  for (const path of ['/api/does-not-exist', '/api/auth/login/x', '/api/health/']) {
    const res = await request.get(path)
    expect(res.status(), path).toBe(401)
    expect(await res.json()).toEqual({ statusCode: 401, message: 'Unauthorized' })
  }
  const res = await request.get('/api/does-not-exist')
  expect(await res.text()).not.toMatch(LEAK)
})

test('unknown API routes return 404 with a session, without stack traces or file paths', async ({
  playwright,
  baseURL,
}) => {
  // A dedicated context: the cookie is __Host- (Secure), so it is passed explicitly.
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL!, ...uniqueClientIpHeaders() },
  })
  try {
    const email = `e2e-unknown-${Date.now().toString(36)}@example.test`
    const password = `quiet harbor lamp ${Math.random().toString(36).slice(2, 8)}`
    const reg = await api.post('/api/auth/register', { data: { email, password, nativeLanguage: 'en' } })
    expect(reg.status()).toBe(201)
    const cookie = reg
      .headersArray()
      .find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('__Host-recallio-session='))
      ?.value.split(';', 1)[0]
    expect(cookie).toBeDefined()

    for (const [method, path] of [
      ['GET', '/api/does-not-exist'],
      ['POST', '/api/does-not-exist'],
      ['GET', '/api/auth/me/x'],
    ] as const) {
      const res = await api.fetch(path, {
        method,
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        ...(method === 'POST' && { data: {} }),
      })
      expect(res.status(), `${method} ${path}`).toBe(404)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ statusCode: 404, message: 'Not Found' })
      expect(text).not.toMatch(LEAK)
    }

    const del = await api.delete('/api/account', { headers: { cookie: cookie! }, data: { password } })
    expect(del.status()).toBe(204)
  } finally {
    await api.dispose()
  }
})
