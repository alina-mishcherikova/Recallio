/** Moves focus to an element by id and scrolls it into view (error summary links, ADR 0002 §7). */
export function focusById(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'center' })
}

/**
 * After a client-side navigation that the user triggered (login, logout, deletion), moves focus to
 * the new page's `h1` so keyboard and screen-reader users start at the top of the new content.
 * The `h1` must have `tabindex="-1"`.
 */
export async function focusPageHeading(): Promise<void> {
  await nextTick()
  const heading = document.querySelector<HTMLElement>('main h1')
  heading?.focus()
}
