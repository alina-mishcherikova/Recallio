import { z } from '../zod'

/**
 * Launch allow-list of ISO 639-1 language codes (CLAUDE.md "Languages", ADR 0001 D5).
 * The database only checks the format (`^[a-z]{2}$`), so adding a language is a code-only change here.
 */
export const LANGUAGE_CODES = ['fr', 'en'] as const
export type LanguageCode = (typeof LANGUAGE_CODES)[number]

/** Fixed message for any language field (never echoes the submitted value). */
export const LANGUAGE_MESSAGE = 'Choose a supported language.'

/** Server-side validation for every language field. Rejects codes outside the allow-list. */
export const languageCodeSchema = z.enum(LANGUAGE_CODES, { error: LANGUAGE_MESSAGE })

/**
 * Create-form defaults (ADR 0003 §4, client-side only): the user's native language and the other
 * launch language. The API never fills missing languages, so a later profile change never touches
 * existing collections (DEC-001).
 */
export function defaultLanguagePair(native: LanguageCode): {
  nativeLanguage: LanguageCode
  targetLanguage: LanguageCode
} {
  return { nativeLanguage: native, targetLanguage: LANGUAGE_CODES.find((c) => c !== native)! }
}
