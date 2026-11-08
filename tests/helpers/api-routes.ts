// Discovers every handler file in server/api/** and the route it serves, using Nitro's file
// conventions (`name.<method>.ts`, `index`, `[param]`, `[...rest]`). U12 and A2 are generated from
// this list, so routes added by later issues are covered automatically.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_DIR = fileURLToPath(new URL('../../server/api', import.meta.url))

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const

export interface ApiRoute {
  /** Path relative to server/api, with forward slashes. */
  file: string
  /** Upper-case method, or 'ALL' when the file name has no method suffix. */
  method: string
  /** Route pattern, e.g. `/api/collections/:id` or `/api/**`. */
  path: string
  source: string
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [full] : []
  })
}

export function listApiRoutes(): ApiRoute[] {
  return walk(API_DIR)
    .map((full) => {
      const file = relative(API_DIR, full).split(sep).join('/')
      const segments = file.replace(/\.(ts|mts|js|mjs)$/, '').split('/')
      let last = segments.pop()!
      let method = 'ALL'
      const suffix = last.split('.').pop()!.toLowerCase()
      if (last.includes('.') && (METHODS as readonly string[]).includes(suffix)) {
        method = suffix.toUpperCase()
        last = last.slice(0, -(suffix.length + 1))
      }
      if (last !== 'index') segments.push(last)
      const path =
        '/api' +
        segments
          .map((s) =>
            /^\[\.\.\..*\]$/.test(s) ? '/**' : /^\[.*\]$/.test(s) ? `/:${s.slice(1, -1)}` : `/${s}`,
          )
          .join('')
      return { file, method, path: path === '/api' ? '/api' : path, source: readFileSync(full, 'utf8') }
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** A concrete request path for a pattern (params → a random-looking UUID, wildcard → a fixed segment). */
export function concretePath(pattern: string): string {
  return pattern.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000').replace('/**', '/does-not-exist')
}
