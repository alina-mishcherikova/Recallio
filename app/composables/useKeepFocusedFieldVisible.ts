/**
 * Keeps the focused text field visible when the on-screen keyboard opens (spec US-UI-01).
 * The keyboard shrinks the visual viewport; when it does, the focused field is scrolled back into
 * the middle of what is still visible. Works together with `min-h-dvh` layouts and the
 * `interactive-widget=resizes-content` viewport setting in app.vue.
 */
export function useKeepFocusedFieldVisible() {
  let viewport: VisualViewport | null = null

  function onResize() {
    const el = document.activeElement
    if (el instanceof HTMLElement && el.matches('input, textarea, select, [contenteditable="true"]')) {
      el.scrollIntoView({ block: 'center' })
    }
  }

  onMounted(() => {
    viewport = window.visualViewport
    viewport?.addEventListener('resize', onResize)
  })
  onBeforeUnmount(() => viewport?.removeEventListener('resize', onResize))
}
