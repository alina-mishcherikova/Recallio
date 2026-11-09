// Icons used by the app and by the Nuxt UI components it renders, as static SVG data.
// Source: Lucide (https://lucide.dev, ISC licence), copied from @iconify-json/lucide. No runtime fetch,
// no generated names, and no inline `style` (the CSP only allows nonce'd styles).
// Add an icon here before using `i-lucide-<name>` anywhere. tests/nuxt/icons.test.ts checks this.

export type IconNode =
  | readonly ['path', { d: string }]
  | readonly ['circle', { cx: string; cy: string; r: string }]
  | readonly ['rect', { width: string; height: string; x: string; y: string; rx: string }]

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
  plus: [['path', { d: 'M5 12h14m-7-7v14' }]],
  'arrow-left': [['path', { d: 'm12 19l-7-7l7-7m7 7H5' }]],
  pencil: [
    [
      'path',
      {
        d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4',
      },
    ],
  ],
  archive: [
    ['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }],
    ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8m-10 4h4' }],
  ],
  'archive-restore': [
    ['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }],
    ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h2M20 8v11a2 2 0 0 1-2 2h-2m-7-6l3-3l3 3m-3-3v9' }],
  ],
  trash: [
    [
      'path',
      {
        d: 'M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      },
    ],
  ],
  'folder-open': [
    [
      'path',
      {
        d: 'm6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
      },
    ],
  ],
} as const satisfies Record<string, readonly IconNode[]>

export type LucideIconName = keyof typeof LUCIDE_ICONS
