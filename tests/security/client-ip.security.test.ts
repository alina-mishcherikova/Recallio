// Rate-limit key resolution (OWASP A06/A07): client-supplied forwarding headers must never be trusted.
import { describe, expect, it } from 'vitest'
import { resolveClientIp } from '../../server/utils/client-ip'

describe('resolveClientIp', () => {
  it('ignores client-supplied X-Forwarded-For and X-Real-IP by default', () => {
    const ip = resolveClientIp({
      socketAddress: '198.51.100.7',
      headers: { 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2' },
    })
    expect(ip).toBe('198.51.100.7')
  })

  it('normalizes IPv4-mapped IPv6 socket addresses', () => {
    expect(resolveClientIp({ socketAddress: '::ffff:127.0.0.1', headers: {} })).toBe('127.0.0.1')
  })

  it('uses the configured trusted proxy header when it holds a valid IP', () => {
    const ip = resolveClientIp({
      socketAddress: '10.0.0.1',
      headers: { 'fly-client-ip': '203.0.113.9' },
      trustedHeader: 'Fly-Client-IP',
    })
    expect(ip).toBe('203.0.113.9')
  })

  it('falls back to the socket when the trusted header is missing or not an IP', () => {
    for (const value of [undefined, '', 'evil', '1.2.3.4, 5.6.7.8', '<script>']) {
      const ip = resolveClientIp({
        socketAddress: '10.0.0.1',
        headers: { 'x-real-ip': value },
        trustedHeader: 'x-real-ip',
      })
      expect(ip).toBe('10.0.0.1')
    }
  })

  it('never returns an attacker-controlled non-IP string', () => {
    expect(resolveClientIp({ socketAddress: undefined, headers: {} })).toBe('unknown')
  })
})
