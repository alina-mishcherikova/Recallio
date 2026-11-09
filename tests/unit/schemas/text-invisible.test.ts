// LEX-004 security review L2: invisible and bidi-control characters are rejected in user text.
import { describe, expect, it } from 'vitest'
import { boundedText, hasForbiddenCharacters, isInvisible } from '../../../shared/schemas/text'

const title = boundedText({
  min: 1,
  max: 200,
  messages: { required: 'required', tooLong: 'tooLong', invalidCharacters: 'invalid' },
})

describe('hasForbiddenCharacters', () => {
  it.each([
    ['zero-width space', 'a\u200Bb'],
    ['right-to-left override', 'a\u202Eb'],
    ['left-to-right isolate', 'a\u2066b'],
    ['BOM inside text', 'a\uFEFFb'],
    ['TAG character', 'a\u{E0041}'],
    ['line separator', 'a\u2028b'],
    ['paragraph separator', 'a\u2029b'],
    ['soft hyphen', 'a\u00ADb'],
  ])('rejects %s', (_name, value) => {
    expect(hasForbiddenCharacters(value, false)).toBe(true)
  })

  it.each([
    ['plain French', 'Mots français : être, où, ça'],
    ['ZWJ emoji sequence', '👩\u200D💻 vocabulaire'],
    ['markup-like text', 'a < b & c > d, <3 French'],
    ['Ukrainian', 'Слова'],
  ])('accepts %s', (_name, value) => {
    expect(hasForbiddenCharacters(value, false)).toBe(false)
  })
})

describe('visible-text rule', () => {
  it('treats fillers and whitespace as invisible', () => {
    expect(isInvisible('\u3164\u3164')).toBe(true)
    expect(isInvisible('\u115F \u1160')).toBe(true)
    expect(isInvisible('a')).toBe(false)
  })

  it('rejects titles with no visible character', () => {
    expect(title.safeParse('\u3164\u3164').error?.issues[0]?.message).toBe('required')
    expect(title.safeParse('\u200B\u200B').success).toBe(false)
  })

  it('accepts normal titles', () => {
    expect(title.safeParse('  Vocabulaire B1  ').data).toBe('Vocabulaire B1')
  })
})
