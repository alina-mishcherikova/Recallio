// Open-redirect guard for `?redirect=` after login (ADR 0002 §2.1, §6.4; OWASP A01).

export const DEFAULT_REDIRECT_PATH = '/dashboard'
const MAX_LENGTH = 512

/** C0 controls, DEL and C1 controls. Browsers strip tabs/newlines, which can turn `/\t/x` into `//x`. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/**
 * Returns `input` only if it is a same-origin absolute path: a string that starts with `/`, not
 * `//` or `/\`, with no scheme, no backslash, no control characters (raw or percent-encoded), and at
 * most 512 characters. Otherwise returns `/dashboard`.
 */
export function safeRedirectPath(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_REDIRECT_PATH
  if (input.length === 0 || input.length > MAX_LENGTH) return DEFAULT_REDIRECT_PATH
  // A value that starts with a single `/` is a path: it can't carry a scheme.
  if (!input.startsWith('/') || input.startsWith('//')) return DEFAULT_REDIRECT_PATH
  if (input.includes('\\') || hasControlCharacter(input)) return DEFAULT_REDIRECT_PATH
  // Percent-encoded controls (%00-%1f, %7f), and an encoded slash or backslash right after the first `/`.
  if (/%(?:[01][0-9a-f]|7f)/i.test(input) || /^\/(?:%2f|%5c)/i.test(input)) return DEFAULT_REDIRECT_PATH
  // Last line of defense: resolving against a placeholder origin must keep that origin.
  const base = 'http://recallio.invalid'
  if (!URL.canParse(input, base) || new URL(input, base).origin !== base) return DEFAULT_REDIRECT_PATH
  return input
}
