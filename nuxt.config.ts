// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-security', '@nuxt/test-utils/module'],
  css: ['~/assets/css/main.css'],
  app: {
    head: { htmlAttrs: { lang: 'en' } }, // WCAG 3.1.1 — UI language is English
  },
  devtools: { enabled: process.env.NODE_ENV !== 'production' },

  typescript: {
    strict: true,
  },

  // Server-only values. Overridden at runtime by NUXT_* env vars and validated at boot
  // (server/plugins/00.env.ts). Never put secrets in `public`.
  runtimeConfig: {
    databaseUrl: '',
    public: {},
  },

  sourcemap: { server: false, client: false },

  // OWASP A02/A05/A08 baseline — see docs/architecture.md §8.
  security: {
    nonce: true,
    headers: {
      contentSecurityPolicy: {
        'default-src': ["'self'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"], // required by Nuxt UI runtime styles
        'script-src': ["'self'", "'strict-dynamic'", "'nonce-{{nonce}}'"],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': process.env.NODE_ENV === 'production',
      },
      crossOriginEmbedderPolicy: process.env.NODE_ENV === 'production' ? 'require-corp' : 'unsafe-none',
      strictTransportSecurity: {
        maxAge: 31536000,
        includeSubdomains: true,
        preload: true,
      },
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        'display-capture': [],
      },
    },
    requestSizeLimiter: {
      maxRequestSizeInBytes: 1_000_000, // 1 MB
      maxUploadFileRequestInBytes: 5_000_000, // 5 MB (CSV import cap)
    },
    rateLimiter: {
      tokensPerInterval: 150,
      interval: 300_000, // per 5 min per IP — stricter per-route limits come with LEX-003
    },
    hidePoweredBy: true,
    corsHandler: false, // same-origin only
  },
})
