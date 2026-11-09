// Human-readable language names for the UI (English UI, WCAG 3.1.1). The codes come from the
// shared allow-list; the server validates every code it receives.
import { LANGUAGE_CODES, type LanguageCode } from '#shared/constants/languages'

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

/** "English" for `en`. Falls back to the code itself if the runtime has no name for it. */
export function languageLabel(code: string): string {
  return languageNames.of(code) ?? code
}

/** Options for a language `<select>`, in allow-list order. */
export const LANGUAGE_ITEMS: readonly { label: string; value: LanguageCode }[] = LANGUAGE_CODES.map(
  (code) => ({
    label: languageLabel(code),
    value: code,
  }),
)

/**
 * A collection's language pair as text, native → target ("English → French"). The direction is
 * always explicit (spec §2): the first language is the one the learner speaks.
 */
export function languagePairLabel(pair: { nativeLanguage: string; targetLanguage: string }): string {
  return `${languageLabel(pair.nativeLanguage)} → ${languageLabel(pair.targetLanguage)}`
}

/** The same pair for screen readers, without the arrow ("English to French"). */
export function languagePairSpoken(pair: { nativeLanguage: string; targetLanguage: string }): string {
  return `${languageLabel(pair.nativeLanguage)} to ${languageLabel(pair.targetLanguage)}`
}
