// Client-side validation for Nuxt UI forms, using the shared Zod schemas (UX only: the server
// re-validates everything). Produces at most one error per field, so the inline message and the
// error summary stay short.
import type { FormError } from '@nuxt/ui'
import type { z } from '#shared/zod'

/** Merges errors per field: distinct messages for the same field are joined into one sentence list. */
export function mergeFieldErrors(errors: FormError[]): FormError[] {
  const byName = new Map<string, string[]>()
  const order: string[] = []
  for (const { name = '', message } of errors) {
    if (!byName.has(name)) {
      byName.set(name, [])
      order.push(name)
    }
    const messages = byName.get(name)!
    if (!messages.includes(message)) messages.push(message)
  }
  return order.map((name) => ({ ...(name ? { name } : {}), message: byName.get(name)!.join(' ') }))
}

/**
 * Runs `schema` on `state` and maps the issues to `FormError`s. `messages` replaces a field's
 * message (for schemas whose default text isn't written for people, such as `z.enum`).
 */
export function schemaFormErrors(
  schema: z.ZodType,
  state: unknown,
  messages: Record<string, string> = {},
): FormError[] {
  const result = schema.safeParse(state)
  if (result.success) return []
  return result.error.issues.map((issue) => {
    const name = issue.path.map(String).join('.')
    return { name, message: messages[name] ?? issue.message }
  })
}
