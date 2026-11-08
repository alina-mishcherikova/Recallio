// Password hashing and the blocklist (ADR 0002 §5.2, §5.3, D5, D6). The only module that calls
// nuxt-auth-utils' scrypt helpers (lint rule in eslint.config.mjs).
import { randomBytes } from 'node:crypto'
import {
  checkPasswordAgainstList,
  normalizePassword,
  type PasswordIssue,
} from '../../../shared/auth/password-policy'

let dummyHash: Promise<string> | undefined
let blocklist: Promise<ReadonlySet<string>> | undefined

/**
 * A hash of a random value, computed once with the current parameters. Unknown-email logins verify
 * against it, so both paths cost one scrypt. It is never compared with a stored value.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
    dummyHash = undefined
    throw error
  })
  return dummyHash
}

/** Server asset (never in the client bundle), loaded once into a Set (about 47k entries). */
export function loadBlocklist(): Promise<ReadonlySet<string>> {
  blocklist ??= useStorage('assets:server')
    .getItem<string>('password-blocklist.txt')
    .then((text) => {
      if (typeof text !== 'string' || text.length === 0) throw new Error('password blocklist is missing')
      return new Set(text.split('\n').filter(Boolean))
    })
    .catch((error: unknown) => {
      blocklist = undefined
      throw error
    })
  return blocklist
}

export async function checkBlocklist(password: string): Promise<PasswordIssue[]> {
  const list = await loadBlocklist()
  return checkPasswordAgainstList(password, (candidate) => list.has(candidate))
}

/** `password` is NFKC-normalized again here, so a caller can't skip it. */
export function hashUserPassword(password: string): Promise<string> {
  return hashPassword(normalizePassword(password))
}

/** Verifies against `storedHash`, or against the dummy hash when there is no user (same cost). */
export async function verifyUserPassword(storedHash: string | undefined, password: string): Promise<boolean> {
  const hash = storedHash ?? (await getDummyHash())
  const ok = await verifyPassword(hash, normalizePassword(password))
  return storedHash !== undefined && ok
}

export function needsRehash(storedHash: string): boolean {
  return passwordNeedsReHash(storedHash)
}
