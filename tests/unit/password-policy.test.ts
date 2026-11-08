// U1–U3 (ADR 0002 §5.3, §8.1): NIST 800-63B password policy. Codes and messages are the contract.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PASSWORD_MAX,
  PASSWORD_MESSAGES,
  PASSWORD_MIN,
  checkPasswordAgainstList,
  checkPasswordShape,
  codePointLength,
  normalizePassword,
} from '../../shared/auth/password-policy'

const codes = (pw: string, email?: string) =>
  checkPasswordShape(normalizePassword(pw), { email }).map((i) => i.code)

describe('length in code points after NFKC (U1)', () => {
  it('11 → too_short, 12 → ok', () => {
    expect(codes('Tr0ub4dor&3')).toEqual(['too_short'])
    expect(codes('Tr0ub4dor&3x')).toEqual([])
  })

  it('128 ok, 129 too_long', () => {
    const base = 'correct horse battery staple '
    const pw128 = base.repeat(5).slice(0, PASSWORD_MAX)
    expect(codePointLength(pw128)).toBe(128)
    expect(codes(pw128)).toEqual([])
    expect(codes(`${pw128}x`)).toEqual(['too_long'])
  })

  it('counts an emoji as one character (12 emoji pass, 11 fail)', () => {
    const emoji = ['😀', '🎉', '🐱', '🌍', '🚀', '🍕', '🎸', '📚', '🔑', '🌈', '⚽', '🧩']
    expect(emoji.join('').length).toBeGreaterThan(12) // UTF-16 units
    expect(codes(emoji.join(''))).toEqual([])
    expect(codes(emoji.slice(0, 11).join(''))).toEqual(['too_short'])
  })

  it('counts combining marks as code points', () => {
    const decomposed = 'cafe\u0301'.repeat(2) + 'xyzw' // NFKC composes e + U+0301 into é
    expect(codePointLength(decomposed)).toBe(14)
    expect(codePointLength(normalizePassword(decomposed))).toBe(12)
  })

  it('NFKC: full-width letters equal their ASCII form', () => {
    expect(normalizePassword('ｐａｓｓｗｏｒｄ')).toBe('password')
  })
})

describe('shape rules (U2)', () => {
  it('contains_email is case-insensitive and needs a local part of 3+ characters', () => {
    expect(codes('my-AliceSmith-key', 'alicesmith@example.test')).toEqual(['contains_email'])
    expect(codes('xyzzy-al-plugh-quux', 'al@example.test')).toEqual([])
  })

  it.each(['aaaaaaaaaaaa', 'abcdefghijkl', '987654321098', 'aabbaabbaabb', 'zyxwvutsrqpo'])(
    '%s → repetitive',
    (pw) => {
      expect(codes(pw)).toContain('repetitive')
    },
  )

  it('rejects the service name', () => {
    expect(codes('my recallio password')).toEqual(['common'])
  })

  it.each([
    'correct horse battery staple',
    'mot de passe très sûr',
    'пароль надёжный 42',
    '密碼很長而且很安全的句子啊',
  ])('accepts spaces and Unicode: %s', (pw) => {
    expect(codes(pw)).toEqual([])
  })

  it('requires nothing: no composition rules', () => {
    expect(codes('alllowercaseletters')).toEqual([])
  })

  it('uses the fixed messages', () => {
    expect(checkPasswordShape('short')[0]).toEqual({
      code: 'too_short',
      message: PASSWORD_MESSAGES.too_short,
    })
    expect(PASSWORD_MESSAGES.too_short).toBe(`Use at least ${PASSWORD_MIN} characters.`)
  })
})

describe('blocklist (U3)', () => {
  it('checks the lowercased, normalized value through the injected lookup', () => {
    const seen: string[] = []
    const has = (s: string) => (seen.push(s), s === 'passwordpassword')
    expect(checkPasswordAgainstList('PassWordPASSWORD', has)).toEqual([
      { code: 'common', message: PASSWORD_MESSAGES.common },
    ])
    expect(checkPasswordAgainstList('ｐａｓｓｗｏｒｄpassword', has).map((i) => i.code)).toEqual(['common'])
    expect(checkPasswordAgainstList('something unusual', has)).toEqual([])
    expect(seen).toContain('something unusual')
  })

  const file = fileURLToPath(new URL('../../server/assets/password-blocklist.txt', import.meta.url))
  const notice = fileURLToPath(new URL('../../server/assets/password-blocklist.NOTICE', import.meta.url))

  it('the bundled list is lowercase, 12–128 code points, NFKC, unique, sorted, ≥ 40,000 entries', () => {
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines.pop()).toBe('') // trailing newline
    expect(lines.length).toBeGreaterThanOrEqual(40_000)
    expect(new Set(lines).size).toBe(lines.length)
    expect([...lines].sort()).toEqual(lines)
    for (const line of lines) {
      const n = codePointLength(line)
      if (n < 12 || n > 128 || line !== line.toLowerCase() || line !== line.normalize('NFKC')) {
        throw new Error(`invalid blocklist entry at length ${n}`)
      }
    }
    for (const known of ['passwordpassword', '123456789012', 'qwertyuiopasdfgh', 'iloveyou1234']) {
      expect(lines).toContain(known)
    }
  })

  it('has a NOTICE with source commit and licence', () => {
    expect(existsSync(notice)).toBe(true)
    const text = readFileSync(notice, 'utf8')
    expect(text).toContain('dbdbd9ae1135fc53ecb0a9880af94178d0fc6264')
    expect(text).toContain('MIT License')
    expect(text).toContain('Daniel Miessler')
  })
})
