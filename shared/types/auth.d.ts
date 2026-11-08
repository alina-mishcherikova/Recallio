// Session shape for nuxt-auth-utils (ADR 0002 §2.1, §4.1). Data minimization: no email or profile
// data in the cookie. The profile comes from GET /api/auth/me.
declare module '#auth-utils' {
  interface User {
    id: string
  }

  /** Server-only: stripped from GET /api/_auth/session by the module. */
  interface SecureSessionData {
    /** user_sessions.id */
    sid: string
    /** Epoch milliseconds of the login that created the session. */
    loggedInAt: number
  }
}

export {}
