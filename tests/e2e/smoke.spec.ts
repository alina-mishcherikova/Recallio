import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('home page loads, is accessible, and sends security headers', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Recallio' })).toBeVisible()

  // WCAG 2.2 AA (US-UI-02)
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(results.violations).toEqual([])

  // OWASP A02 baseline
  const headers = response!.headers()
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-powered-by']).toBeUndefined()
})

test('health endpoint reports database status without leaking details', async ({ request }) => {
  const res = await request.get('/api/health')
  expect([200, 503]).toContain(res.status())
  const body = await res.json()
  expect(Object.keys(body).sort()).toEqual(['database', 'status'])
})
