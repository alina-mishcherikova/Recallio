// U3 (ADR 0001 §6.1, D5): the launch allow-list is enforced in Zod; the DB checks only the format.
import { describe, expect, it } from 'vitest'
import { LANGUAGE_CODES, languageCodeSchema } from '../../shared/constants/languages'

describe('languageCodeSchema', () => {
  it('accepts the launch languages', () => {
    expect([...LANGUAGE_CODES]).toEqual(['fr', 'en'])
    for (const code of LANGUAGE_CODES) expect(languageCodeSchema.parse(code)).toBe(code)
  })

  it.each(['de', 'FR', 'fra', '', ' fr', 'e', null, 1])('rejects %j', (code) => {
    expect(languageCodeSchema.safeParse(code).success).toBe(false)
  })
})
