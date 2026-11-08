// The only place that imports `zod` directly in shared/ and server/ (lint rule in eslint.config.mjs).
// Zod 4 decides at the first `z.object()` construction whether it may JIT-compile parsers, and probes
// with `new Function('')`. Under our CSP (no 'unsafe-eval') that probe is reported as a violation,
// so JIT is turned off before any schema exists. Import `z` from here on the client and the server.
import { z, ZodError } from 'zod'

z.config({ jitless: true })

export { z, ZodError }
export type { ZodType } from 'zod'
