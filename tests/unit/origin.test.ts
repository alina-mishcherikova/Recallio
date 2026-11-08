// U8 (ADR 0002 §6.5, D3): the origin check over every header combination.
import { describe, expect, it } from 'vitest'
import { checkRequestOrigin, hasRequestBody, isJsonContentType } from '../../server/utils/origin'

const appOrigin = 'https://recallio.app'
const sites = [undefined, 'same-origin', 'same-site', 'cross-site', 'none', 'SAME-ORIGIN'] as const
const origins = [
  undefined,
  appOrigin,
  'null',
  'https://recallio.app/',
  'https://evil.example',
  'http://recallio.app',
  'https://recallio.app:444',
  'https://sub.recallio.app',
] as const

function expected(site: string | undefined, origin: string | undefined) {
  if (site === undefined && origin === undefined) return 'forbidden'
  if (site !== undefined && site.toLowerCase() !== 'same-origin') return 'forbidden'
  if (origin !== undefined && origin !== appOrigin) return 'forbidden'
  return 'ok'
}

describe('checkRequestOrigin', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const site of sites) {
      for (const origin of origins) {
        const want = expected(site, origin)
        it(`${method} site=${site ?? '-'} origin=${origin ?? '-'} → ${want}`, () => {
          expect(checkRequestOrigin({ method, secFetchSite: site, origin, appOrigin })).toBe(want)
        })
      }
    }
  }

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('%s is never blocked', (method) => {
    expect(
      checkRequestOrigin({ method, secFetchSite: 'cross-site', origin: 'https://evil.example', appOrigin }),
    ).toBe('ok')
  })

  it('fails closed when appOrigin is empty', () => {
    expect(checkRequestOrigin({ method: 'POST', secFetchSite: undefined, origin: '', appOrigin: '' })).toBe(
      'forbidden',
    )
  })
})

describe('JSON-only bodies', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])('%s is JSON', (ct) => {
    expect(isJsonContentType(ct)).toBe(true)
  })

  it.each([
    undefined,
    '',
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json-patch+json',
    'text/json',
  ])('%s is not JSON', (ct) => {
    expect(isJsonContentType(ct)).toBe(false)
  })

  it('detects a body from framing headers', () => {
    expect(hasRequestBody({})).toBe(false)
    expect(hasRequestBody({ contentLength: '0' })).toBe(false)
    expect(hasRequestBody({ contentLength: '2' })).toBe(true)
    expect(hasRequestBody({ transferEncoding: 'chunked' })).toBe(true)
  })
})
