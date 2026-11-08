// Password policy (ADR 0002 §2.1, §5.3; NIST SP 800-63B). Pure functions, no list data: the
// blocklist is server-only (server/assets/password-blocklist.txt) and is injected through `has`.
// No composition rules: nothing is ever *required*, only weak shapes are rejected.

/** Minimum length in Unicode code points, counted after NFKC. */
export const PASSWORD_MIN = 12
/** Maximum length in Unicode code points, counted after NFKC. */
export const PASSWORD_MAX = 128
/** Input bound in UTF-16 code units, checked before normalization. A DoS bound, not the policy. */
export const PASSWORD_INPUT_MAX = 1024

/** The service name is never accepted inside a password (NIST: context-specific words). */
const SERVICE_NAME = 'recallio'

export type PasswordIssueCode = 'too_short' | 'too_long' | 'contains_email' | 'repetitive' | 'common'

export interface PasswordIssue {
  code: PasswordIssueCode
  message: string
}

/** Fixed messages: the server and the UI show the same text. */
export const PASSWORD_MESSAGES: Readonly<Record<PasswordIssueCode, string>> = Object.freeze({
  too_short: `Use at least ${PASSWORD_MIN} characters.`,
  too_long: `Use at most ${PASSWORD_MAX} characters.`,
  contains_email: "Don't use your email address in your password.",
  repetitive: 'Avoid repeated or sequential characters, like aaaa or 1234.',
  common: "This password is too common. Choose one that's harder to guess.",
})

const issue = (code: PasswordIssueCode): PasswordIssue => ({ code, message: PASSWORD_MESSAGES[code] })

/** NFKC normalization (NIST 800-63B §5.1.1.2). Applied before hashing and before verifying. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC')
}

/** Length in Unicode code points (an emoji counts as one, a combining mark as one). */
export function codePointLength(value: string): number {
  let n = 0
  for (const _ of value) n++
  return n
}

const DIGIT_0 = 0x30
const LOWER_A = 0x61

/** Signed step between two code points: digits wrap 9→0, letters wrap z→a. Otherwise the raw difference. */
function step(a: number, b: number): number {
  const isDigit = (c: number) => c >= DIGIT_0 && c <= DIGIT_0 + 9
  const isLetter = (c: number) => c >= LOWER_A && c <= LOWER_A + 25
  const mod = (x: number, m: number) => ((x % m) + m) % m
  if (isDigit(a) && isDigit(b)) {
    const d = mod(b - a, 10)
    return d === 1 ? 1 : d === 9 ? -1 : 0
  }
  if (isLetter(a) && isLetter(b)) {
    const d = mod(b - a, 26)
    return d === 1 ? 1 : d === 25 ? -1 : 0
  }
  return b - a
}

/** True when the whole value is one ascending or descending run (`abcdefghijkl`, `987654321098`). */
function isSequentialRun(codePoints: number[]): boolean {
  if (codePoints.length < 2) return false
  const first = step(codePoints[0]!, codePoints[1]!)
  if (first !== 1 && first !== -1) return false
  for (let i = 1; i < codePoints.length - 1; i++) {
    if (step(codePoints[i]!, codePoints[i + 1]!) !== first) return false
  }
  return true
}

/**
 * Shape checks that need no list data (safe to run in the browser). `password` must already be
 * normalized (`passwordInputSchema` does this). `email` is the normalized (lowercased) address.
 */
export function checkPasswordShape(password: string, opts: { email?: string } = {}): PasswordIssue[] {
  const issues: PasswordIssue[] = []
  const length = codePointLength(password)
  if (length < PASSWORD_MIN) issues.push(issue('too_short'))
  if (length > PASSWORD_MAX) issues.push(issue('too_long'))

  const lower = password.toLowerCase()
  const local = opts.email?.split('@')[0]?.toLowerCase() ?? ''
  // Local parts shorter than 3 characters would reject too many unrelated passwords.
  if (codePointLength(local) >= 3 && lower.includes(local)) issues.push(issue('contains_email'))

  const codePoints = Array.from(lower, (c) => c.codePointAt(0)!)
  if (new Set(codePoints).size < 4 || isSequentialRun(codePoints)) issues.push(issue('repetitive'))

  if (lower.includes(SERVICE_NAME)) issues.push(issue('common'))
  return issues
}

/**
 * Blocklist check (case-insensitive). `has` receives the lowercased, normalized password. The server
 * passes a Set lookup over the bundled list; a later HIBP or Bloom-filter check can use the same API.
 */
export function checkPasswordAgainstList(
  password: string,
  has: (candidate: string) => boolean,
): PasswordIssue[] {
  return has(normalizePassword(password).toLowerCase()) ? [issue('common')] : []
}
