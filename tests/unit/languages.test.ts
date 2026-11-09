// U3 (ADR 0001 §6.1, D5): the launch allow-list is enforced in Zod; the DB checks only the format.
import { describe, expect, it } from 'vitest'
import { LANGUAGE_CODES, defaultLanguagePair, languageCodeSchema } from '../../shared/constants/languages'

describe('languageCodeSchema', () => {
  it('accepts the launch languages', () => {
    expect([...LANGUAGE_CODES]).toEqual(['fr', 'en'])
    for (const code of LANGUAGE_CODES) expect(languageCodeSchema.parse(code)).toBe(code)
  })

  it.each(['de', 'FR', 'fra', '', ' fr', 'e', null, 1])('rejects %j', (code) => {
    expect(languageCodeSchema.safeParse(code).success).toBe(false)
  })
})

describe('defaultLanguagePair (U9, ADR 0003 §4)', () => {
  it('pairs the native language with the other launch language', () => {
    expect(defaultLanguagePair('fr')).toEqual({ nativeLanguage: 'fr', targetLanguage: 'en' })
    expect(defaultLanguagePair('en')).toEqual({ nativeLanguage: 'en', targetLanguage: 'fr' })
  })

  it.each(LANGUAGE_CODES)('always differs (%s)', (code) => {
    const pair = defaultLanguagePair(code)
    expect(pair.targetLanguage).not.toBe(pair.nativeLanguage)
    expect(LANGUAGE_CODES).toContain(pair.targetLanguage)
  })
})
