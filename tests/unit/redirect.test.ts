// U6 (ADR 0002 §2.1, §6.4): no open redirect after login.
import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '../../shared/auth/redirect'

describe('safeRedirectPath', () => {
  it.each([
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://x.example',
    'javascript:alert(1)',
    '/%0d%0aSet-Cookie:x',
    '/%2f%2fevil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'dashboard',
    '',
    `/${'a'.repeat(512)}`,
    null,
    undefined,
    42,
    ['/collections'],
  ])('%j → /dashboard', (input) => {
    expect(safeRedirectPath(input)).toBe('/dashboard')
  })

  it.each(['/collections/1?x=1', '/account', '/review#top', '/'])('keeps %s', (input) => {
    expect(safeRedirectPath(input)).toBe(input)
  })
})
