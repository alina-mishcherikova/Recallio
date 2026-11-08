// Builds server/assets/password-blocklist.txt (ADR 0002 §5.3, D5). Reproducible: pinned upstream
// commit, pinned SHA-256 of each source file, deterministic filtering and sort.
//
//   pnpm auth:blocklist                 # downloads the two pinned files
//   pnpm auth:blocklist --from <dir>    # uses local copies (same file names), e.g. offline
//
// Downloaded files are treated as untrusted data: they are only read as text, never executed, and
// rejected unless their hash matches. Only the filtered list is written to the repository.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'dbdbd9ae1135fc53ecb0a9880af94178d0fc6264'
const BASE = `https://raw.githubusercontent.com/danielmiessler/SecLists/${COMMIT}/`
const SOURCES = [
  {
    path: 'Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt',
    sha256: '424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51',
  },
  {
    path: 'Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt',
    sha256: 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0',
  },
] as const

// Same bounds and normalization as shared/auth/password-policy.ts (12–128 code points after NFKC).
const MIN = 12
const MAX = 128
const OUT = fileURLToPath(new URL('../server/assets/password-blocklist.txt', import.meta.url))

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

async function load(source: (typeof SOURCES)[number], fromDir: string | undefined): Promise<Buffer> {
  const name = source.path.split('/').pop()!
  let data: Buffer
  if (fromDir) {
    data = await readFile(join(fromDir, name))
  } else {
    const response = await fetch(BASE + source.path, { redirect: 'error' })
    if (!response.ok) throw new Error(`download failed (${response.status}): ${source.path}`)
    data = Buffer.from(await response.arrayBuffer())
  }
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== source.sha256) throw new Error(`SHA-256 mismatch for ${name}: got ${digest}`)
  return data
}

async function main() {
  const fromIndex = process.argv.indexOf('--from')
  const fromDir = fromIndex >= 0 ? process.argv[fromIndex + 1] : undefined

  const entries = new Set<string>()
  for (const source of SOURCES) {
    const text = (await load(source, fromDir)).toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      const value = line.normalize('NFKC').toLowerCase()
      if (hasControl(value)) continue
      const length = [...value].length
      if (length >= MIN && length <= MAX) entries.add(value)
    }
  }
  const sorted = [...entries].sort()
  await writeFile(OUT, `${sorted.join('\n')}\n`, 'utf8')
  console.warn(`wrote ${sorted.length} entries to server/assets/password-blocklist.txt`)
}

await main()
