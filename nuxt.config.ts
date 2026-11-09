// https://nuxt.com/docs/api/configuration/nuxt-config
import { join } from 'node:path'
import { addServerHandler, defineNuxtModule } from 'nuxt/kit'

// Literals (not imported from server/utils/env.ts): this file is evaluated before the server is built.
const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 30 // 30 days (ADR 0002 §4.2)

/**
 * Registers the CSRF and auth middleware (ADR 0002 §3) *after* nuxt-security's handlers. Nitro runs
 * scanned server/middleware/* before every module handler, which would put the auth DB lookup in
 * front of the global per-IP rate limiter and the 1 MB body limit. Listed after nuxt-security.
 */
const recallioRequestPipeline = defineNuxtModule({
  meta: { name: 'recallio-request-pipeline' },
  setup(_options, nuxt) {
    for (const name of ['01.origin', '02.auth']) {
      addServerHandler({ handler: join(nuxt.options.serverDir, 'handlers', `${name}.ts`), middleware: true })
    }
  },
})

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: [
    '@nuxt/ui',
    '@nuxt/eslint',
    'nuxt-security',
    '@nuxt/test-utils/module',
    'nuxt-auth-utils',
    recallioRequestPipeline, // after nuxt-security: see above
  ],
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
    // Header set by a trusted reverse proxy (e.g. 'fly-client-ip'). Empty = use the socket address.
    trustedIpHeader: '',
    // NUXT_APP_SECRET: at least 32 characters. Seals the session cookie (HKDF in nuxt/server) and
    // keys the audit/rate-limit HMACs. Generated on the dev server; required in built servers.
    appSecret: '',
    // NUXT_APP_ORIGIN, e.g. https://recallio.app. CSRF origin check (server/handlers/01.origin.ts).
    appOrigin: '',
    session: {
      name: '__Host-recallio-session', // ADR 0002 D8: Secure, Path=/, no Domain
      maxAge: SESSION_ABSOLUTE_SECONDS, // absolute timeout; the session is written only at login
      cookie: { sameSite: 'lax', secure: true, httpOnly: true },
    },
    public: {},
  },

  // ADR 0002 D6: scrypt N=2^14, r=8, p=5 (OWASP). 16 MiB per hash. Re-measure on the host (LEX-017).
  auth: {
    hash: { scrypt: { cost: 16384, blockSize: 8, parallelization: 5, maxMemory: 33554432 } },
  },

  icon: {
    // Out of /api/** so deny-by-default doesn't block icons for anonymous visitors (ADR 0002 §1.2).
    localApiEndpoint: '/_nuxt_icon',
    // Never fetch icons from api.iconify.design (browser or server). The data comes from the
    // @iconify-json/lucide devDependency, bundled at build time (security review L3; CSP connect-src).
    fallbackToApi: false,
    serverBundle: { collections: ['lucide'] },
    clientBundle: {
      scan: true, // icons referenced in app/** (e.g. eye, eye-off)
      // Nuxt UI's built-in defaults (loader-circle for loading buttons, x, chevrons, ...), which a
      // scan of our sources can't see.
      icons: [
        'lucide:arrow-down',
        'lucide:arrow-left',
        'lucide:arrow-right',
        'lucide:arrow-up',
        'lucide:arrow-up-right',
        'lucide:check',
        'lucide:chevron-down',
        'lucide:chevron-left',
        'lucide:chevron-right',
        'lucide:chevron-up',
        'lucide:chevrons-left',
        'lucide:chevrons-right',
        'lucide:circle-alert',
        'lucide:circle-check',
        'lucide:circle-x',
        'lucide:copy',
        'lucide:copy-check',
        'lucide:ellipsis',
        'lucide:eye',
        'lucide:eye-off',
        'lucide:file',
        'lucide:folder',
        'lucide:folder-open',
        'lucide:grip-vertical',
        'lucide:hash',
        'lucide:info',
        'lucide:lightbulb',
        'lucide:loader-circle',
        'lucide:menu',
        'lucide:minus',
        'lucide:monitor',
        'lucide:moon',
        'lucide:panel-left-close',
        'lucide:panel-left-open',
        'lucide:plus',
        'lucide:rotate-ccw',
        'lucide:search',
        'lucide:square',
        'lucide:star',
        'lucide:sun',
        'lucide:terminal',
        'lucide:triangle-alert',
        'lucide:upload',
        'lucide:x',
      ],
      sizeLimitKb: 256,
    },
  },

  routeRules: {
    // nuxt-security's XSS validator is off for the JSON API. It only inspected GET/POST, rejected
    // legitimate text (passwords per NIST 800-63B, "a < b", "<3 French") with an unexplained 400, and
    // never ran on PATCH. XSS is prevented where it matters: strict Zod schemas on input, Vue's output
    // escaping, the v-html/innerHTML lint bans and the nonce-only CSP (LEX-004 security review, L1).
    '/api/**': { headers: { 'cache-control': 'no-store' }, security: { xssValidator: false } },
  },

  nitro: {
    // Auth rate-limit counters (server/services/auth/counter-store.ts). Per process: LEX-017 mounts
    // a shared driver with atomic increments before a second instance runs.
    storage: { 'auth-limits': { driver: 'memory' } },
  },

  hooks: {
    // JSON errors for /api/** first (server/error-handler.ts); Nuxt's handler keeps rendering pages.
    // Nuxt sets its handler before this hook runs, so we prepend ours to the chain.
    'nitro:config'(config) {
      config.errorHandler = ['~~/server/error-handler', ...[config.errorHandler ?? []].flat()]
    },
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
        'style-src': ["'self'", "'nonce-{{nonce}}'"],
        'script-src': ["'self'", "'strict-dynamic'", "'nonce-{{nonce}}'"],
        'script-src-attr': ["'none'"],
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
      interval: 300_000, // one bucket per trusted client IP (/64 for IPv6) per matched route rule,
      // shared by the whole app. Per-user write limits: follow-up in LEX-017 (LEX-004 review, L3).
      // In-memory per process: switch to a shared driver before running >1 instance. Per-account
      // auth limits: server/services/auth/rate-limit.ts.
    },
    hidePoweredBy: true,
    corsHandler: false, // same-origin only
  },
})
