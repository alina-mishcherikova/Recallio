// Every icon the app (and the Nuxt UI parts it uses) renders comes from the static set in
// app/utils/icons.ts, as an SVG without a `style` attribute (nonce-only CSP).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { LUCIDE_ICONS } from '~/utils/icons'
import PasswordInput from '~/components/auth/PasswordInput.vue'

const APP_DIR = join(process.cwd(), 'app')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(vue|ts)$/.test(name) ? [path] : []
  })
}

/** Nuxt UI's default icons for the components we render (Button loading, Toast close, ...). */
const NUXT_UI_ICONS = ['loader-circle', 'x', 'check', 'chevron-down', 'circle-check', 'info', 'circle-alert']

describe('icons', () => {
  it('every i-lucide-* name used in app/** is registered locally', () => {
    const used = new Set<string>()
    for (const file of files(APP_DIR)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/i-lucide-([a-z0-9-]+)/g)) used.add(match[1]!)
    }
    expect(used.size).toBeGreaterThan(0)
    for (const name of [...used, ...NUXT_UI_ICONS]) expect(Object.keys(LUCIDE_ICONS)).toContain(name)
  })

  it('UIcon renders the local SVG, with no style attribute', async () => {
    // PasswordInput's toggle is a UButton with `icon="i-lucide-eye"` (UButton → UIcon → @nuxt/icon).
    const wrapper = await mountSuspended(PasswordInput, {
      props: { id: 'pw', autocomplete: 'current-password' },
    })
    const svg = wrapper.get('svg[data-icon="eye"]')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('class')).toMatch(/size-/)
    expect(wrapper.html()).not.toMatch(/\sstyle=/)
  })
})
