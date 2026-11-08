// Starts the built server for black-box suites (API: ADR 0002 §8.3, E2E: §8.4). Shared by
// tests/api/global-setup.ts and tests/e2e/global-setup.ts.
//   - builds if .output is missing or older than the sources (`rebuild: true` forces it)
//   - spawns `node .output/server/index.mjs` with a minimal environment: nothing from the
//     developer's shell (dev database URL, NUXT_SESSION_PASSWORD, ...) leaks in
//   - a fresh random NUXT_APP_SECRET per run (no committed secret) and a fresh in-memory
//     rate-limit store per run (no app-side bypass needed)
//   - stdout and stderr go to a log file
// Never prints URLs or the secret.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCES = ['app', 'server', 'shared', 'public', 'nuxt.config.ts', 'package.json', 'pnpm-lock.yaml']

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)))
  return newest
}

export function ensureBuild(rebuild = false) {
  const marker = join(ROOT, '.output', 'nitro.json')
  const built = existsSync(marker) ? statSync(marker).mtimeMs : 0
  const sources = Math.max(...SOURCES.map((s) => newestMtime(join(ROOT, s))))
  if (!rebuild && built > sources) return
  const result = spawnSync('pnpm', ['build'], { cwd: ROOT, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').slice(-30).join('\n')
    throw new Error(`pnpm build failed:\n${tail}`)
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** Fails if something already answers on `origin`: the tests would silently run against it. */
export async function assertNothingListening(origin: string) {
  try {
    await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    return
  }
  throw new Error(
    `Something is already listening on ${new URL(origin).host}. Stop it: each test run starts its own ` +
      'server against the test database (fresh rate-limit store, random secret).',
  )
}

async function waitForHealth(origin: string, child: ChildProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited during startup (code ${child.exitCode})`)
    try {
      const res = await fetch(`${origin}/api/health`)
      if (res.status === 200) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('the server did not become healthy in time')
}

export interface StartedServer {
  stop: () => Promise<void>
}

export async function startBuiltServer(o: {
  port: number
  origin: string
  databaseUrl: string
  logFile: string
  host?: string
  trustedIpHeader?: string
}): Promise<StartedServer> {
  const log = createWriteStream(o.logFile)
  const child = spawn(process.execPath, [join(ROOT, '.output/server/index.mjs')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      ...(o.host && { HOST: o.host }),
      PORT: String(o.port),
      NUXT_DATABASE_URL: o.databaseUrl,
      NUXT_APP_SECRET: randomBytes(32).toString('base64url'),
      NUXT_APP_ORIGIN: o.origin,
      ...(o.trustedIpHeader && { NUXT_TRUSTED_IP_HEADER: o.trustedIpHeader }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.pipe(log)
  child.stderr!.pipe(log)
  try {
    await waitForHealth(o.origin, child)
  } catch (error) {
    child.kill('SIGKILL')
    log.end()
    throw error
  }
  return {
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
      log.end()
    },
  }
}
