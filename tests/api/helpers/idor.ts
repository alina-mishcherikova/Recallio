// Reusable IDOR check (ADR 0002 §8.3 A11) for LEX-004+: user A creates a resource, user B requests
// it with B's own session. The answer must be 404 (never 403, which would confirm existence) for
// owned routes, and must never contain A's data.
import { expect } from 'vitest'
import { Client, type ApiResponse } from './client'

export async function expectIdor<T>(o: {
  /** Creates A's resource with A's client; returns what identifies it (an id). */
  setupA: (client: Client) => Promise<T>
  setupB: (client: Client) => Promise<void>
  /** B's request for A's resource. */
  request: (client: Client, resource: T) => Promise<ApiResponse>
  /** Expected status for B. Owned routes: 404 (default). Session-scoped routes: their own success code. */
  status?: number
  /** True if the body reveals A's resource. */
  leaks: (body: unknown, resource: T) => boolean
}): Promise<void> {
  const a = new Client()
  const resource = await o.setupA(a)
  const b = new Client()
  await o.setupB(b)
  const res = await o.request(b, resource)
  expect(res.status).toBe(o.status ?? 404)
  expect(o.leaks(res.body, resource)).toBe(false)
}
