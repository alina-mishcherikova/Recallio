// Keys derived from NUXT_APP_SECRET for the audit log and the rate-limit account keys (ADR 0002
// §5.4, §6.6). HKDF purposes are distinct from the session cookie's (`nuxt-session:<name>`).
import { deriveSecret } from 'nuxt/server'
import { setAuditKey } from '../../utils/audit'

export interface AuthKeys {
  rateLimit: Uint8Array
  audit: Uint8Array
}

let keys: Promise<AuthKeys> | undefined

export function loadAuthKeys(): Promise<AuthKeys> {
  keys ??= Promise.all([deriveSecret('recallio:rate-limit'), deriveSecret('recallio:audit')])
    .then(([rateLimit, audit]) => {
      const loaded = { rateLimit: Buffer.from(rateLimit, 'hex'), audit: Buffer.from(audit, 'hex') }
      setAuditKey(loaded.audit)
      return loaded
    })
    .catch((error: unknown) => {
      keys = undefined
      throw error
    })
  return keys
}
