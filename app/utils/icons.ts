// Icons used by the app and by the Nuxt UI components it renders, as static SVG data.
// Source: Lucide (https://lucide.dev, ISC licence), copied from @iconify-json/lucide. No runtime fetch,
// no generated names, and no inline `style` (the CSP only allows nonce'd styles).
// Add an icon here before using `i-lucide-<name>` anywhere. tests/nuxt/icons.test.ts checks this.

export type IconNode =
  readonly ['path', { d: string }] | readonly ['circle', { cx: string; cy: string; r: string }]

export const LUCIDE_ICONS = {
  eye: [
    [
      'path',
      {
        d: 'M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0',
      },
    ],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'eye-off': [
    [
      'path',
      {
        d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575a1 1 0 0 1 0 .696a10.8 10.8 0 0 1-1.444 2.49m-6.41-.679a3 3 0 0 1-4.242-4.242',
      },
    ],
    [
      'path',
      {
        d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 4.446-5.143M2 2l20 20',
      },
    ],
  ],
  'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
  'circle-alert': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 8v4m0 4h.01' }],
  ],
  'circle-check': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm16 9l-5.5 5.5L8 12' }],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 16v-4m0-4h.01' }],
  ],
  x: [['path', { d: 'M18 6L6 18M6 6l12 12' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  'chevron-down': [['path', { d: 'm6 9l6 6l6-6' }]],
} as const satisfies Record<string, readonly IconNode[]>

export type LucideIconName = keyof typeof LUCIDE_ICONS
