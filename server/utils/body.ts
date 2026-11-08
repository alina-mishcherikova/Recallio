// Strict JSON bodies for /api/** (ADR 0002 §2.2). The Content-Type is enforced earlier by
// server/handlers/01.origin.ts (415); the size by nuxt-security (413).
import { readRawBody, type H3Event } from 'h3'
import { publicError } from './errors'

/** `undefined` for an empty body; 400 for anything that isn't valid JSON. Never echoes the input. */
export async function readJsonBody(event: H3Event): Promise<unknown> {
  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined || raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw publicError(400)
  }
}
