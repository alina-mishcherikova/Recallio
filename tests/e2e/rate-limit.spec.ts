// Rate limiter bypass regression (LEX-001 security review, M1). Runs last, in its own project,
// because it drains the /api/health bucket for this client.
import { expect, test } from '@playwright/test'

test('rotating a client-supplied X-Forwarded-For does not reset the rate limit', async ({ request }) => {
  const statuses: number[] = []
  for (let i = 0; i < 170 && !statuses.includes(429); i++) {
    statuses.push((await request.get('/api/health')).status())
  }
  expect(statuses).toContain(429)

  for (const spoof of ['203.0.113.200', '198.51.100.1, 10.0.0.1']) {
    const res = await request.get('/api/health', {
      headers: { 'x-forwarded-for': spoof, 'x-real-ip': spoof },
    })
    expect(res.status()).toBe(429)
  }
})
