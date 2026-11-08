// Page access (ADR 0002 §6.4). Pages are protected by default, like the API:
// - `definePageMeta({ auth: 'public' })`: anyone.
// - `definePageMeta({ auth: 'guest' })`: signed-out visitors; a signed-in user goes to /dashboard.
// - anything else: signed-in users; a guest goes to /login?redirect=<same-origin path>.
// This is a UX layer only. The server enforces access on every /api/** request.
declare module '#app' {
  interface PageMeta {
    auth?: 'public' | 'guest'
  }
}

export default defineNuxtRouteMiddleware((to) => {
  if (to.meta.auth === 'public') return

  const { loggedIn } = useUserSession()
  if (to.meta.auth === 'guest') {
    if (loggedIn.value) return navigateTo('/dashboard', { replace: true })
    return
  }
  if (!loggedIn.value) return navigateTo(loginLocation(to.fullPath), { replace: true })
})
