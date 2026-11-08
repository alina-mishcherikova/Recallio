// Ownership checks (ADR 0002 §2.4; CLAUDE.md rule 5; OWASP A01).
import type { H3Event } from 'h3'
import { audit, type AuditResource } from './audit'
import { requireAuth } from './auth'
import { publicError } from './errors'

type Owned = { ownerId: string } | { userId: string }

function ownerOf(row: Owned): unknown {
  return 'ownerId' in row ? row.ownerId : row.userId
}

/**
 * Prefer owner-scoped queries (`where owner_id = userId`), which return nothing for other users'
 * rows, then call this on the result. Missing or foreign → 404 'Not Found' plus an `access.denied`
 * audit event. Never 403: it would confirm that the resource exists.
 */
export function requireOwner<T extends Owned>(
  event: H3Event,
  row: T | null | undefined,
  resource: AuditResource,
): T {
  const { userId } = requireAuth(event)
  if (!row || ownerOf(row) !== userId) {
    audit(event, 'access.denied', { reason: 'not_owner', resource })
    throw publicError(404)
  }
  return row
}
