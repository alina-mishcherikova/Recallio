// The only place in app/** that talks to the auth API (ADR 0002 §2.2, §7).
// - Every mutating request sends a JSON body (`$fetch` serializes objects and sets
//   `Content-Type: application/json`); the server answers 415 to anything else.
// - Credentials only ever travel in request bodies: never in URLs, never in storage.
// - The session state comes from nuxt-auth-utils (`useUserSession`), which only holds `{ user: { id } }`.
//   The profile is loaded from GET /api/auth/me when a page needs it.
// - `useUserSession().clear()` is never used: it calls DELETE /api/_auth/session, which the server
//   blocks. Logging out always goes through POST /api/auth/logout.
import type {
  AuthUserResponse,
  DeleteAccountRequest,
  LoginRequest,
  LogoutRequest,
  PublicUser,
  RegisterRequest,
} from '#shared/schemas/auth'

/** `useFetch`/`useState` key for the profile. Cleared on logout and deletion. */
export const PROFILE_KEY = 'auth-profile'

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const e = error as { statusCode?: number; response?: { status?: number } }
  return e.response?.status ?? e.statusCode
}

export function useAuth() {
  const session = useUserSession()
  const route = useRoute()

  async function afterSessionChange() {
    clearNuxtData(PROFILE_KEY)
    await session.fetch()
  }

  async function register(body: RegisterRequest): Promise<PublicUser> {
    const res = await $fetch<AuthUserResponse>('/api/auth/register', { method: 'POST', body })
    await afterSessionChange()
    return res.user
  }

  async function login(body: LoginRequest): Promise<PublicUser> {
    const res = await $fetch<AuthUserResponse>('/api/auth/login', { method: 'POST', body })
    await afterSessionChange()
    return res.user
  }

  /**
   * Logs out (this device, or every device). A 401 means the session was already gone, which is
   * the outcome the user wanted. Any other failure is rethrown and the user stays signed in.
   */
  async function logout(scope: NonNullable<LogoutRequest>['scope'] = 'current'): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST', body: { scope } })
    } catch (error) {
      if (statusOf(error) !== 401) throw error
    }
    await afterSessionChange()
    await navigateTo('/login')
    await focusPageHeading()
  }

  /** Permanently deletes the account after re-entering the password, then goes to the home page. */
  async function deleteAccount(body: DeleteAccountRequest): Promise<void> {
    await $fetch('/api/account', { method: 'DELETE', body })
    await afterSessionChange()
    await navigateTo('/')
    await focusPageHeading()
  }

  /** Call when a protected API answers 401: the session expired or was revoked elsewhere. */
  async function handleUnauthorized(): Promise<void> {
    await afterSessionChange()
    await navigateTo(loginLocation(route.fullPath))
  }

  return {
    loggedIn: session.loggedIn,
    ready: session.ready,
    register,
    login,
    logout,
    deleteAccount,
    handleUnauthorized,
  }
}

/**
 * The signed-in user's profile from GET /api/auth/me. Client-only (`server: false`), so personal
 * data is never embedded in server-rendered HTML. Redirects to /login on 401.
 */
export function useProfile() {
  const { handleUnauthorized } = useAuth()
  const result = useFetch('/api/auth/me', {
    key: PROFILE_KEY,
    server: false,
    lazy: true,
    retry: false,
    transform: (res: AuthUserResponse): PublicUser => res.user,
  })
  watch(result.error, (error) => {
    if (error && statusOf(error) === 401) void handleUnauthorized()
  })
  return result
}

/**
 * Email typed on /register, carried to /login in memory when the address already has an account.
 * Never written to the URL or to storage.
 */
export function useEmailHandoff() {
  return useState<string | null>('auth-email-handoff', () => null)
}
