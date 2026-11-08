// Theme (WCAG 2.2 AA). Calm teal primary on slate neutrals. The shades used for text and buttons
// are set in app/assets/css/main.css (700 in light mode, 300 in dark mode).
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'teal',
      secondary: 'sky',
      success: 'green',
      info: 'blue',
      warning: 'amber',
      error: 'red',
      neutral: 'slate',
    },
    button: {
      // Nuxt UI darkens solid buttons on hover with 75 % opacity, which lowers the contrast of the
      // label. Use the next shade instead (800 in light mode, 200 in dark mode).
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class:
            'hover:bg-primary-800 active:bg-primary-800 dark:hover:bg-primary-200 dark:active:bg-primary-200',
        },
        {
          color: 'error',
          variant: 'solid',
          class: 'hover:bg-error-800 active:bg-error-800 dark:hover:bg-error-200 dark:active:bg-error-200',
        },
      ],
    },
  },
  icon: {
    // Icons we use are registered as local SVG components (app/plugins/icons.ts). For anything else,
    // SVG mode avoids the CSS mode's runtime <style> tags, which the nonce-only CSP blocks.
    mode: 'svg',
  },
})
