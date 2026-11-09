// Bounded user text (ADR 0003 §2.1). The DB CHECKs count code points (`char_length`), Zod's `.max()`
// counts UTF-16 units, so lengths are checked on `[...s].length` after NFC + trim.
import { z } from '../zod'

export interface BoundedTextOptions {
  /** Minimum code points after NFC + trim (0 = blank allowed). */
  min: number
  /** Maximum code points after NFC + trim. */
  max: number
  /** Allows `\n` (CRLF / CR are normalized to LF first). Every other C0/C1 control is rejected. */
  multiline?: boolean
  messages: {
    /** Missing, wrong type, or shorter than `min`. */
    required: string
    tooLong: string
    invalidCharacters: string
  }
}

/** Code-point length, the same unit as Postgres `char_length`. */
export function codePointLength(value: string): number {
  return [...value].length
}

// Unicode format characters (Cf: zero-width space, bidi overrides/isolates, BOM, TAG characters, …)
// except U+200D ZERO WIDTH JOINER, which emoji sequences need. Also the line/paragraph separators.
const FORBIDDEN_FORMAT = /(?!\u200D)[\p{Cf}\u2028\u2029]/u
// Characters that render as nothing: whitespace, format characters, Hangul fillers.
const INVISIBLE = /^[\s\p{Cf}\u115F\u1160\u3164\uFFA0]*$/u

/**
 * C0 controls, DEL, C1 controls (`\n` allowed when `allowNewline`), lone surrogates, and invisible
 * format characters that enable spoofing (LEX-004 security review, L2).
 */
export function hasForbiddenCharacters(value: string, allowNewline: boolean): boolean {
  if (!value.isWellFormed()) return true
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x0a && allowNewline) continue
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return FORBIDDEN_FORMAT.test(value)
}

/** True when the text has no visible character (empty, whitespace or fillers only). */
export function isInvisible(value: string): boolean {
  return INVISIBLE.test(value)
}

/**
 * `string → (CRLF → LF) → NFC → trim → no control characters → min..max code points`.
 * The raw input is bounded first (4 UTF-16 units per allowed code point, plus slack for trimmed
 * whitespace), so a huge string is rejected before it is normalized.
 */
export function boundedText({ min, max, multiline = false, messages }: BoundedTextOptions) {
  let schema = z
    .string({ error: messages.required })
    .max(max * 4 + 64, { error: messages.tooLong, abort: true })
  if (multiline) schema = schema.overwrite((s) => s.replace(/\r\n?/g, '\n'))
  // One issue at most, and no `abort`: an explicitly aborted issue would skip the object-level
  // `when` refinements (for example "languages differ"), so a submit would not report every problem.
  return schema
    .normalize('NFC')
    .trim()
    .superRefine((s, ctx) => {
      if (hasForbiddenCharacters(s, multiline)) {
        ctx.addIssue({ code: 'custom', message: messages.invalidCharacters })
        return
      }
      const length = codePointLength(s)
      if (min > 0 && length > 0 && isInvisible(s))
        ctx.addIssue({ code: 'custom', message: messages.required })
      else if (length < min) ctx.addIssue({ code: 'custom', message: messages.required })
      else if (length > max) ctx.addIssue({ code: 'custom', message: messages.tooLong })
    })
}
