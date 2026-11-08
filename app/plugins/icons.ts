// Registers each icon in app/utils/icons.ts as a global component named `lucide:<name>`.
// @nuxt/icon (behind Nuxt UI's UIcon) renders a registered component instead of fetching the icon
// when one exists with the resolved name, so `<UIcon name="i-lucide-eye" />` and Nuxt UI's
// internal icons (loading, close, check) render this static SVG.
// The SVG never gets a `style` attribute: @nuxt/icon passes `style: null`, which Vue's SSR would
// otherwise render as `style=""`, a CSP violation under the nonce-only style policy.
import { defineComponent, h } from 'vue'
import { LUCIDE_ICONS } from '~/utils/icons'

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'stroke-width': '2',
} as const

export default defineNuxtPlugin({
  name: 'recallio-icons',
  enforce: 'pre',
  setup(nuxtApp) {
    for (const [name, nodes] of Object.entries(LUCIDE_ICONS)) {
      const component = defineComponent({
        name: `LucideIcon-${name}`,
        inheritAttrs: false,
        props: { name: { type: String, default: '' }, customize: { type: null, default: null } },
        setup(_, { attrs }) {
          return () =>
            h(
              'svg',
              {
                xmlns: 'http://www.w3.org/2000/svg',
                viewBox: '0 0 24 24',
                width: '1em',
                height: '1em',
                'aria-hidden': 'true',
                focusable: 'false',
                class: attrs.class,
                'data-slot': attrs['data-slot'],
                'data-icon': name,
              },
              [
                h(
                  'g',
                  STROKE,
                  nodes.map(([tag, a]) => h(tag, a)),
                ),
              ],
            )
        },
      })
      nuxtApp.vueApp.component(`lucide:${name}`, component)
    }
  },
})
