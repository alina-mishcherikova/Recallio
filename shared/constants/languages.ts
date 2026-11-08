import { z } from 'zod'

/**
 * Launch allow-list of ISO 639-1 language codes (CLAUDE.md "Languages", ADR 0001 D5).
 * The database only checks the format (`^[a-z]{2}$`), so adding a language is a code-only change here.
 */
export const LANGUAGE_CODES = ['fr', 'en'] as const
export type LanguageCode = (typeof LANGUAGE_CODES)[number]

/** Server-side validation for every language field. Rejects codes outside the allow-list. */
export const languageCodeSchema = z.enum(LANGUAGE_CODES)
