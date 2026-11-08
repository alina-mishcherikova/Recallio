# 0002 — Authentication, sessions, and deny-by-default authorization (LEX-003)

- **Status:** Accepted (2026-11-09). Alina accepted the recommendations for D1–D10 (§9), in particular
  D2 = (A) `user_sessions` table (migrations 0005 generated + 0006 grants), D3 = (a) no CSRF token
  (strict `Sec-Fetch-Site`/`Origin` against `NUXT_APP_ORIGIN` plus JSON-only bodies), and D4 = (a) 409 with
  a fixed message on a duplicate email plus 10 registrations per hour per IP. Implementation notes: §13.
- **Date:** 2026-11-08
- **Issue:** LEX-003 (#4), branch `feat/lex-003-authentication`
- **Inputs:** `docs/spec.md` US-AUTH-01, US-UI-01, US-UI-02, §15 · `docs/architecture.md` §2, §4, §8 ·
  ADR 0001 (users table, roles, grants, cascades) · `CLAUDE.md` rules 5, 6, 7
- **Verified against:** `nuxt-auth-utils@0.6.2` (npm tarball read in a temp directory, not installed in the repo),
  `nuxt@4.6.4` `nuxt/server` session and secret code (`node_modules/nuxt/dist/server/{session,secret,iron}.js`),
  `@adonisjs/hash@9.1.1` scrypt driver, `nitropack@2.13.6` error-handler chain, `nuxt-security@2.7.0` rate limiter,
  `@nuxt/icon@2.6.2`, and SecLists password lists (counts in §5.3). scrypt timings were measured locally.

---

## 1. Context

LEX-003 adds accounts, sessions, and the access-control layer that every later issue builds on.
Acceptance criteria from the issue: **protected endpoints return 401 without a session; IDOR and auth
abuse tests pass; passwords are never logged or returned.**

### 1.1 Scope

| ID                                  | Criterion                                                                                   | How this issue meets it                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| US-AUTH-01                          | "Users can register, log in, and log out."                                                  | `POST /api/auth/register`, `/login`, `/logout`; `/register`, `/login` pages; logout button               |
| US-AUTH-01                          | "Passwords are securely hashed."                                                            | scrypt (N=2^14, r=8, p=5) via `hashPassword`, rehash on login when parameters change (§5.2)              |
| US-AUTH-01                          | "Protected endpoints require authentication."                                               | Deny-by-default middleware plus `requireAuth()` in every handler (§6)                                    |
| US-AUTH-01                          | "Users cannot access another user's vocabulary or progress."                                | `event.context.auth.userId` is the only identity source; `requireOwner()` → 404; IDOR harness (§6.4, §8) |
| US-UI-01                            | Mobile, tablet, desktop layouts; keyboard and touch; 44 px targets                          | Auth pages tested on the desktop and mobile Playwright projects                                          |
| US-UI-02                            | Accessible names, keyboard, visible focus, not color only, WCAG 2.2 AA                      | Labels, error summary, `autocomplete`, password toggle, axe in E2E (§7)                                  |
| Spec §15 Security                   | Authn/authz mandatory; server-side validation; protection against unauthorized modification | Zod `.strict()` everywhere, CSRF origin check (§6.5), rate limits (§5.4)                                 |
| Spec §15 Privacy                    | "Users must be able to request account deletion."                                           | `DELETE /api/account` (password required) → hard delete through cascades                                 |
| Architecture §8 A01/A07/A08/A09/A10 | Access control, authentication, CSRF, audit logs, central error handler                     | §5, §6, §6.5, §6.6, §6.7                                                                                 |

**Out of scope:** email verification and password reset (decision #5, accepted risk), password change,
email change, MFA, a "devices" list, full navigation (LEX-015), shared rate-limit storage (LEX-017).

### 1.2 What nuxt-auth-utils 0.6 actually does (read from the source)

The 0.6 line is a rewrite on top of `nuxt/server` (Nuxt 4.6). Several facts change the plan in the issue text:

1. **`NUXT_SESSION_PASSWORD` is no longer used.** The module strips `session.password` and logs a warning
   when it is set. The cookie is sealed (iron-webcrypto) with a key derived by HKDF-SHA256 from Nuxt's
   **`appSecret`** (`NUXT_APP_SECRET`, at least 32 characters), purpose `nuxt-session:<cookie name>`.
   Dev servers generate a secret; builds don't, and `deriveSecret()` throws a 500 on the **first request**
   that needs it. So we validate `appSecret` at boot (§2.5).
2. **Cookie defaults:** `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, name `nuxt-auth-session`. Nuxt
   returns a 500 if the sealed cookie is larger than 4096 bytes.
3. **`maxAge` counts from the last write.** It sets both the cookie lifetime and the iron TTL inside the
   seal. Reading a session never re-seals it. Every `setUserSession`/`replaceUserSession` call extends it.
4. **Reading a session without a cookie creates one.** `getSession()` seals an empty session into the
   response when there is no cookie. The module's `GET /api/_auth/session` checks for the cookie first;
   our code must do the same, or anonymous visitors get a cookie on every API call.
5. **The session `id` is stable across updates.** `replaceUserSession()` replaces the data but keeps the
   id. Only `clearUserSession()` creates a new id. Rotation is therefore `clear` + `replace` (§5.5).
6. **`hashPassword`/`verifyPassword`** use `@adonisjs/hash` scrypt. Defaults: `cost` 16384, `blockSize` 8,
   `parallelization` 1, `saltSize` 16, `keyLength` 64, `maxMemory` 32 MiB. Output is a PHC string
   (`$scrypt$n=…,r=…,p=…$salt$hash`, well under the 512-char DB check). `verify` reads the parameters
   from the stored hash, compares with `safeEqual`, and returns `false` on malformed hashes.
   `passwordNeedsReHash` detects changed parameters. Options go in `auth.hash.scrypt` in `nuxt.config.ts`.
7. **Built-in routes:** `GET /api/_auth/session` (used by `useUserSession()` during SSR and on the client;
   strips the `secure` key) and `DELETE /api/_auth/session` (clears the cookie; used by `useUserSession().clear()`).
8. **`sessionHooks`** offers `fetch` and `clear` hooks.

Other findings:

- **`@nuxt/icon` (pulled in by Nuxt UI) serves icons from `GET /api/_nuxt_icon/:collection`.** Deny-by-default
  would break icons for anonymous visitors. We move it to `/_nuxt_icon` with `icon.localApiEndpoint` (§2.5).
- **Nitro chains error handlers.** It normalizes `errorHandler` to an array and runs each one until one
  sets `event.handled`. Nuxt only adds its own handler when none is configured, but it does so **before**
  the `nitro:config` hook. So we prepend ours in that hook and keep Nuxt's for HTML pages (§6.7).
- **nuxt-security's CSRF** option installs `nuxt-csurf`, which is already in the lockfile as a dependency
  of nuxt-security but is not enabled.

---

## 2. Contracts

Backend owns `shared/**` and writes these files first, so the frontend can start in parallel.

### 2.1 Zod schemas: `shared/schemas/auth.ts`

```ts
import { z } from 'zod'
import { languageCodeSchema } from '../constants/languages'
import {
  PASSWORD_MIN,
  PASSWORD_MAX,
  PASSWORD_INPUT_MAX,
  checkPasswordShape,
  normalizePassword,
} from '../auth/password-policy'

/** Trim, lowercase, then validate. Stored in a citext column, so case never creates duplicates. */
export const emailSchema = z
  .string()
  .max(320) // input bound before trimming
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).min(3).max(254))
  .refine((e) => e.split('@')[0]!.length <= 64, 'Enter a valid email address.')

/** NFKC-normalized (NIST 800-63B). Used for login and re-authentication: no policy, only bounds. */
export const passwordInputSchema = z
  .string()
  .min(1, 'Enter your password.')
  .max(PASSWORD_INPUT_MAX) // 1024 UTF-16 units: a DoS bound, not the policy
  .transform(normalizePassword)

/** IANA time zone, checked against Intl. Optional at registration, default 'UTC'. */
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isSupportedTimeZone, 'Choose a valid time zone.')

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordInputSchema,
    nativeLanguage: languageCodeSchema, // 'fr' | 'en'
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // length 12–128 code points, no single-character or simple-sequence passwords,
    // must not contain the email local part (when it has 3+ characters). The blocklist is server-only.
    for (const issue of checkPasswordShape(v.password, { email: v.email }))
      ctx.addIssue({ code: 'custom', path: ['password'], message: issue.message })
  })

export const loginRequestSchema = z.object({ email: emailSchema, password: passwordInputSchema }).strict()

export const logoutRequestSchema = z
  .object({ scope: z.enum(['current', 'all']).default('current') })
  .strict()
  .default({ scope: 'current' }) // an empty body is allowed

export const deleteAccountRequestSchema = z.object({ password: passwordInputSchema }).strict()

/** The only user shape that ever leaves the server. Built field by field, never by spreading a row. */
export const publicUserSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    nativeLanguage: languageCodeSchema,
    timezone: z.string(),
    dailyNewLimit: z.number().int(),
    dailyReviewLimit: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export type PublicUser = z.infer<typeof publicUserSchema>

export const authUserResponseSchema = z.object({ user: publicUserSchema }).strict()

/** Error body for every /api/** error (§6.7). `issues` only on 400, with fixed messages (D7). */
export const apiErrorSchema = z
  .object({
    statusCode: z.number().int(),
    message: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .max(20)
      .optional(),
  })
  .strict()
```

Also in `shared/`:

- `shared/auth/password-policy.ts`: pure functions, no list data. `PASSWORD_MIN = 12`, `PASSWORD_MAX = 128`
  (Unicode code points, counted after NFKC), `PASSWORD_INPUT_MAX = 1024`, `normalizePassword` (NFKC),
  `checkPasswordShape(pw, { email })` and `checkPasswordAgainstList(pw, has: (s) => boolean)`. Both return
  `{ code, message }[]`. Codes: `too_short`, `too_long`, `contains_email`, `repetitive`, `common`.
- `shared/auth/redirect.ts`: `safeRedirectPath(input: unknown): string` returns `input` only if it is a
  string that starts with `/`, doesn't start with `//` or `/\`, has no scheme and no control characters,
  and is at most 512 characters. Otherwise it returns `/dashboard`.
- `shared/types/auth.d.ts` (module augmentation for `#auth-utils`):
  `User = { id: string }`, `SecureSessionData = { sid: string; loggedInAt: number }`. No email or
  profile data in the cookie (data minimization; the profile comes from `GET /api/auth/me`).

Policy messages (fixed strings; the server and the UI use the same text):

| Code             | Message                                                         |
| ---------------- | --------------------------------------------------------------- |
| `too_short`      | Use at least 12 characters.                                     |
| `too_long`       | Use at most 128 characters.                                     |
| `contains_email` | Don't use your email address in your password.                  |
| `repetitive`     | Avoid repeated or sequential characters, like aaaa or 1234.     |
| `common`         | This password is too common. Choose one that's harder to guess. |

`repetitive` is rejected when there are fewer than 4 distinct code points, or when the whole password is
a single ascending or descending run (`abcdefghijkl`, `987654321098`). NIST 800-63B lists these as examples
of passwords to reject. This is not a composition rule: nothing is ever _required_.

### 2.2 API routes

All bodies are JSON (`Content-Type: application/json`, otherwise 415). Every route sends
`Cache-Control: no-store` (route rule on `/api/**`) and `X-Request-Id`.

| Method + path               | Auth        | Request                             | Success                                                                                                       | Errors (body = `apiErrorSchema`)                                                                                                                |
| --------------------------- | ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`   | public      | `registerRequestSchema`             | **201** `{ user }` + session cookie (signed in)                                                               | 400 validation/policy (`issues`), 409 "Could not create an account with this email. If you already have one, log in." (D4), 429 + `Retry-After` |
| `POST /api/auth/login`      | public      | `loginRequestSchema`                | **200** `{ user }` + rotated session cookie                                                                   | 400 shape only, **401 "Email or password is incorrect."** (same for unknown email and wrong password), 429 + `Retry-After`                      |
| `POST /api/auth/logout`     | session     | `logoutRequestSchema` or empty body | **204**, cookie cleared, session row(s) deleted                                                               | 401                                                                                                                                             |
| `GET /api/auth/me`          | session     | none (query must be empty, strict)  | **200** `{ user }` (from the DB)                                                                              | 401                                                                                                                                             |
| `DELETE /api/account`       | session     | `deleteAccountRequestSchema`        | **204**, cookie cleared, `DELETE FROM users` (cascade)                                                        | 400, 401 (no session), **403 "Password is incorrect."**, 429 + `Retry-After`                                                                    |
| `GET /api/_auth/session`    | public      | none                                | module route: `{}` or `{ id, user: { id }, loggedInAt? }`, validated by our middleware first                  | none                                                                                                                                            |
| `DELETE /api/_auth/session` | **blocked** | none                                | always **404** (middleware). Logout has one path, which revokes the server-side row and writes the audit log. |                                                                                                                                                 |

**`/api/auth/me` vs `/api/_auth/session`:** keep both, with different jobs. `useUserSession()` needs the
module route for SSR hydration and `loggedIn`. It only carries `{ user: { id } }` and is validated by
the middleware (§6.2), so a revoked or deleted session reads as `{}`. `GET /api/auth/me` is a normal
protected route that returns the profile from the database, so the cookie holds no personal data and
never goes stale.

### 2.3 Database: new table `user_sessions` (D2, recommended)

`server/db/schema/sessions.ts`, re-exported from `server/db/schema/index.ts`:

| Column         | Type                                               | Notes                                      |
| -------------- | -------------------------------------------------- | ------------------------------------------ |
| `id`           | `uuid` PK `defaultRandom()`                        | The `sid` inside the sealed cookie         |
| `user_id`      | `uuid` not null → `users.id` **ON DELETE CASCADE** | Indexed                                    |
| `created_at`   | `timestamptz` not null default `now()`             | Login time                                 |
| `last_seen_at` | `timestamptz` not null default `now()`             | Idle timeout; touched at most once an hour |
| `expires_at`   | `timestamptz` not null                             | `created_at + 30 days` (absolute timeout)  |

Checks: `user_sessions_expiry` `expires_at > created_at and expires_at <= created_at + interval '30 days'`;
`user_sessions_seen` `last_seen_at >= created_at`. Index `(user_id)`. No IP address or user agent (data
minimization). A future "devices" list can add columns.

**Migrations** (merged migrations are never edited, ADR 0001 §5):

| File                   | How                                                | Content                                                                                                                                        |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0005_<generated>.sql` | `pnpm db:generate`                                 | `user_sessions` table, FK, checks, index                                                                                                       |
| `0006_auth_grants.sql` | `drizzle-kit generate --custom --name auth_grants` | `GRANT SELECT, INSERT, DELETE ON public.user_sessions TO recallio_app;` `GRANT UPDATE (last_seen_at) ON public.user_sessions TO recallio_app;` |

Consequences for the existing tests (they are designed to catch this): the privilege matrix
(`roles.test.ts`) gets a `user_sessions` row, the cascade test X1 needs a `createSession` factory (it fails
on any unseeded table), and `schema-parity.test.ts` and the drift check pass with no change.
No SRS objects are touched. The cascade runs as the table owner, as for every other table.

**If D2 = B instead:** one generated migration adds `users.session_version integer not null default 1
check (session_version >= 1)`, plus a custom grant `GRANT UPDATE (session_version) ON public.users`.

### 2.4 Server-side context and helpers (contract for every later issue)

```ts
// server/utils/auth.ts (auto-imported)
declare module 'h3' {
  interface H3EventContext {
    requestId: string
    auth?: { userId: string; sessionId: string } // set only by server/middleware/02.auth.ts
  }
}

/** Every protected handler calls this first. Throws 401 if the middleware didn't authenticate. */
export function requireAuth(event: H3Event): { userId: string; sessionId: string }

// server/utils/authz.ts
/**
 * For later issues. Prefer owner-scoped queries (`where owner_id = userId`), which return nothing
 * for other users' rows. Then call this on the result: missing or foreign → 404 'Not Found',
 * plus an `access.denied` audit event. Never 403 (it would confirm the resource exists).
 */
export function requireOwner<T extends { ownerId: string } | { userId: string }>(
  event: H3Event,
  row: T | null | undefined,
  resource: AuditResource, // 'collection' | 'entry' | 'card' | ...
): T
```

Services never read `event` (layering rule). They take `(db, userId, input)`. The **`db` parameter**
lets integration tests call services against the test database without Nitro (§8.2).

### 2.5 Configuration and boot validation

`nuxt.config.ts` (backend):

```ts
modules: [..., 'nuxt-auth-utils'],
auth: { hash: { scrypt: { cost: 16384, blockSize: 8, parallelization: 5, maxMemory: 33554432 } } }, // D6
runtimeConfig: {
  appSecret: '',            // NUXT_APP_SECRET; ≥ 32 chars; validated at boot in built servers
  appOrigin: '',            // NUXT_APP_ORIGIN, e.g. https://recallio.app; required in built servers
  session: {
    name: '__Host-recallio-session', // D8; no Domain attribute, Path=/, Secure
    maxAge: 60 * 60 * 24 * 30,       // 30 days = absolute timeout; the session is written only at login
    cookie: { sameSite: 'lax', secure: true, httpOnly: true },
  },
},
icon: { localApiEndpoint: '/_nuxt_icon' },              // out of /api/**; public, static icon data
routeRules: { '/api/**': { headers: { 'cache-control': 'no-store' } } },
nitro: { storage: { 'auth-limits': { driver: 'memory' } } }, // swapped to Redis in LEX-017
hooks: { 'nitro:config'(c) { c.errorHandler = ['~~/server/error-handler', ...[c.errorHandler ?? []].flat()] } },
```

`server/utils/env.ts` → `serverConfigSchema` gains (messages never echo values):

- `appSecret`: built server → string of at least 32 characters, not equal to the `.env.example` placeholder.
- `appOrigin`: built server → `https://` origin with no path, query, or fragment (`http://` allowed
  only for loopback hosts, so local E2E works). Dev default: `http://localhost:3000`.
- `sessionCookieSecure`: built server → must not be `false`.
- If `NUXT_SESSION_PASSWORD` is set: fail in built servers with "is not used by nuxt-auth-utils 0.6; set
  NUXT_APP_SECRET" (avoids a false sense of configuration).

`.env.example` gains `NUXT_APP_SECRET=` (empty; "generate with `openssl rand -base64 32`"; dev works
without it) and `NUXT_APP_ORIGIN=http://localhost:3000`. Playwright's `webServer` sets a test
`NUXT_APP_SECRET` and `NUXT_APP_ORIGIN=http://localhost:3100`.

---

## 3. Request pipeline

```
request
 ├─ plugin 01.client-ip (request hook)     event.context.clientIp (existing)
 ├─ plugin 03.request-context (new)        event.context.requestId = randomUUID(); X-Request-Id header
 │                                         (never taken from the client)
 ├─ nuxt-security                          headers, 1 MB body limit, global per-IP limiter (existing)
 ├─ middleware 00.db-role                  503 until the role check passes (existing)
 ├─ middleware 01.origin (new)             CSRF: mutating methods need same origin; /api JSON only (§6.5)
 ├─ middleware 02.auth (new)               resolve session → context.auth; deny by default (§6.2)
 └─ handler                                requireAuth(event) → Zod parse → service(db, userId, input) → DTO
errors → server/error-handler.ts (/api/** JSON) → Nuxt's handler (HTML pages) → Nitro default
```

The tester confirms the real order of nuxt-security's handlers and `server/middleware/*` in the built
server. The global limiter must run before the auth DB lookup.

---

## 4. Sessions

### 4.1 Cookie content

`{ user: { id }, secure: { sid, loggedInAt } }`, sealed with the key derived from `appSecret`, a few
hundred bytes. `secure` never leaves the server (the module strips it from `/api/_auth/session`).

### 4.2 Timeouts and revocation (D2 = A, recommended)

- **Absolute 30 days:** enforced twice. (1) The cookie and the iron TTL are set to 30 days at login, and
  the session is **never written again** after login (lint rule, §6.3), so the TTL can't be extended.
  (2) `user_sessions.expires_at` is checked on every request with the database clock.
- **Idle 7 days:** `last_seen_at > now() - interval '7 days'`, checked on every request. The middleware
  touches `last_seen_at` only if it is more than 1 hour old, so there is at most one write per session
  per hour. The idle window can therefore end up to 1 hour early, never late.
- **Per-request check** (one indexed query, plus at most one update an hour):
  `select s.id, s.last_seen_at from user_sessions s where s.id = $sid and s.user_id = $uid and
s.expires_at > now() and s.last_seen_at > now() - interval '7 days'`. The FK cascade means a deleted
  user has no rows, so **a deleted user's cookie fails here.** This lookup is needed anyway: without it,
  a deleted user's cookie would authenticate and later fail with FK errors (500s).
- **Logout (`scope: 'current'`):** `delete from user_sessions where id = $sid and user_id = $uid`, then
  `clearUserSession`. A stolen copy of the cookie stops working immediately (ASVS 5.0 V7.4.1).
- **Logout everywhere (`scope: 'all'`):** `delete … where user_id = $uid`. Later, password change and
  email change reuse this.
- **Cleanup:** at login, delete the user's expired or idle rows and keep at most **10 active sessions
  per user** (oldest deleted first). A Nitro plugin runs an hourly sweep
  (`delete … where expires_at <= now() or last_seen_at <= now() - interval '7 days'`), and the app role
  has DELETE on the table.

### 4.3 Why not stateless sealed cookies with `session_version` (D2 = B)

It costs the same per-request lookup (we need it for deleted users), but `logout` would have to bump the
version, which logs the user out **on every device**. That conflicts with US-UI-01 ("progress is preserved
when switching devices"). A plain logout that doesn't bump would leave stolen cookies valid for up to
7 days, which fails ASVS V7.4.1, our stated baseline. The sessions table costs one extra small table and
a grant migration, and gives exact per-session revocation and exact server-side timeouts.

### 4.4 Rotation (fixation)

On login (and on register): delete the `user_sessions` row of any session presented in the request,
insert a new row, then `clearUserSession(event)` (new nuxt session id) and `replaceUserSession(event,
{ user: { id }, secure: { sid, loggedInAt } })`. Nuxt writes one `Set-Cookie` per cookie name, so the
response contains exactly one new cookie. An attacker-planted cookie, anonymous or the attacker's own
session, is never upgraded. The `__Host-` prefix (D8) stops a sibling subdomain from planting a cookie.

---

## 5. Authentication

### 5.1 Email

Trimmed and lowercased in Zod, stored in `citext` (unique `users_email_key`). 3–254 characters, local
part ≤ 64. ASCII addresses only (Zod's default `z.email()` pattern). Internationalized addresses are a
later change. No verification (decision #5).

### 5.2 Password hashing

scrypt via `hashPassword`, **N = 2^14, r = 8, p = 5** (D6). This is one of OWASP's equivalent scrypt
settings; the library default p = 1 is below OWASP's minimum. It uses 16 MiB per hash (Node runs the
p lanes one after another) and takes about 115 ms on the dev machine (N=2^14 p=1: 26 ms; N=2^17 p=1:
208 ms and 128 MiB). Re-measure on the production host in LEX-017 and aim for 100–300 ms.

- NFKC normalization (`normalizePassword`) before both hashing and verifying.
- On a successful login, `passwordNeedsReHash` → rehash and `update users set password_hash` (the app
  role already has that column grant).
- **Dummy hash:** a Nitro plugin computes `DUMMY_HASH = await hashPassword(randomBytes(32))` once at
  boot, with the current parameters. Unknown-email logins run `verifyPassword(DUMMY_HASH, password)`, so
  both paths cost one scrypt. The dummy is never compared with a stored value.
- Optional hardening if load tests show queueing: a semaphore of 4 concurrent hashes with a queue of 50,
  then 503. Node's libuv pool already caps parallelism at 4.

### 5.3 Password policy (NIST SP 800-63B)

12–128 code points after NFKC, any Unicode allowed (spaces too), **no composition rules**, no periodic
expiry, no hints. Reject: blocklisted (case-insensitive), contains the email local part (case-insensitive,
when the local part has 3+ characters; shorter ones would cause false positives), fewer than 4 distinct
characters, a single sequential run, or the service name (`recallio`). Paste and password managers are
allowed (`autocomplete="new-password"`).

**Blocklist (D5).** The "top 10k" list is almost useless with a 12-character minimum: SecLists
`10k-most-common.txt` has **10** entries of 12+ characters. Recommended source, from
[SecLists](https://github.com/danielmiessler/SecLists) (MIT licence, © Daniel Miessler), pinned to commit
`dbdbd9ae1135fc53ecb0a9880af94178d0fc6264`:

- `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` (Mark Burnett's 2015 dataset)
- `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (UK NCSC, derived from HIBP)

Filtered to 12–128 characters, lowercased, de-duplicated, sorted: **46,888 entries, 686 KB (332 KB
gzipped)**. Spot check: `passwordpassword`, `123456789012`, `qwertyuiopasdfgh`, `iloveyou1234` are
listed. It ships as `server/assets/password-blocklist.txt` (Nitro server assets, **never in the client
bundle**) with a `NOTICE` (source, commit, licence, generation command). It is loaded once into a
`Set<string>` at boot (about 4 MB of memory). The generation script is `scripts/build-password-blocklist.ts`,
so the file can be reproduced and refreshed. The licence of the two upstream datasets is the SecLists
MIT licence for the compilation; the security agent confirms the attribution text.

Alternatives: the HIBP k-anonymity API (best coverage, but an external call on every registration, a
privacy disclosure, and a new failure mode), or a Bloom filter of a larger list (smaller file,
false positives). Both can come later behind the same `checkPasswordAgainstList(pw, has)` function.

### 5.4 Rate limiting and backoff

A custom limiter in `server/services/auth/rate-limit.ts` sits on top of a small `CounterStore` interface
backed by `useStorage('auth-limits')` (memory driver now; LEX-017 mounts Redis and must use atomic
`INCR`/`PEXPIRE`). Entries carry their own `resetAt`/`expiresAt`, so expired entries are treated as
missing. A plugin prunes expired keys every minute and caps the store at 100,000 keys (the oldest
are evicted first). Keys never contain an email in clear: `acct:` keys use
`HMAC-SHA256(deriveSecret('recallio:rate-limit'), normalizedEmail)`.

| Key                        | Counts                                   | Threshold                                                                                                                                                                          | When exceeded                     |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `login:ip:<ip>`            | failed logins from an IP                 | 20 per 15 min (fixed window)                                                                                                                                                       | 429, `Retry-After` = window end   |
| `login:acct:<hmac(email)>` | consecutive failures for an email        | 5 free; then each attempt must wait `min(15 s × 2^(failures − 5), 15 min)` after the last failure (15 s, 30 s, 1 min, … 15 min). Reset on success. TTL 24 h after the last failure | 429, `Retry-After` = seconds left |
| `register:ip:<ip>`         | all registration attempts                | 10 per hour                                                                                                                                                                        | 429                               |
| `reauth:user:<userId>`     | wrong passwords on `DELETE /api/account` | same backoff as `login:acct`                                                                                                                                                       | 429                               |
| nuxt-security global       | every request per route per IP           | 150 per 5 min (existing)                                                                                                                                                           | 429                               |

- Limits are checked **before** the user lookup and the hash, so a locked-out attempt costs no scrypt.
- The account key exists **whether or not the email is registered**, so backoff never reveals existence.
- No permanent lockout: without password reset, a lockout would let an attacker lock any user out for
  good. The 15-minute cap keeps a sustained attack to about 100 guesses a day per account (NIST: at most
  100 consecutive failures). The cost is that an attacker can make a victim wait up to 15 minutes
  (accepted risk, logged).
- The 429 message is "Too many attempts. Try again in N minutes." for both kinds of limits.

### 5.5 Flows

**Login:** Zod → IP and account limits → `select … from users where email = $1` → `verifyPassword(user?.passwordHash ?? DUMMY_HASH, pw)`
→ if no user or no match: record the failures, audit, 401 → otherwise reset the account counter, rehash
if needed, rotate (§4.4), audit, 200 `{ user }`.

**Register:** Zod (shape and policy) → IP limit → blocklist → `hashPassword` (**always**, before touching
the DB) → `insert into users … returning` → catch 23505 on `users_email_key` → 409 (D4); no pre-check
`select`, so both paths do the same work → create the session (§4.4) → 201 `{ user }`.

**Delete account:** `requireAuth` → Zod → `reauth` limit → verify the password against the stored hash
(403 and record on failure) → `delete from users where id = $userId` (one statement; cascades to every
user-owned table, including `user_sessions` and the SRS tables, ADR 0001 X1) → `clearUserSession` →
audit `account.deleted` → 204.

---

## 6. Authorization, CSRF, errors, and logging

### 6.1 Public allow-list (`server/utils/public-routes.ts`)

```ts
export const PUBLIC_API_ROUTES = new Set([
  'GET /api/health',
  'POST /api/auth/register',
  'POST /api/auth/login',
  'GET /api/_auth/session',
])
export function isPublicApiRoute(method: string, path: string): boolean // HEAD is matched as GET
```

Matching is exact on the method and on `event.path` without the query string, which is the same value
the Nitro router sees. No prefixes, no globs, no trailing-slash normalization. Anything that doesn't match
exactly (`/api/health/`, `/api/auth/login/x`) requires a session (fail closed).

### 6.2 Middleware `server/middleware/02.auth.ts`

1. Only for paths starting with `/api/`. Pages and assets are not API surfaces. Pages get their data from `/api`.
2. `DELETE /api/_auth/session` → 404.
3. If the session cookie exists (checked with `getCookie` first, §1.2 item 4): unseal, require
   `user.id` and `secure.sid`, run the per-request check (§4.2). Valid → `event.context.auth = { userId, sessionId }`.
   Invalid, expired, revoked, or user deleted → `clearUserSession`, audit `auth.session.invalid` with a
   reason, and continue as anonymous.
4. If the route is not public and `context.auth` is missing → audit `access.denied` (`unauthenticated`)
   and **401 "Unauthorized"**.
5. **Unknown routes:** without a session, any non-allow-listed `/api/**` path gets 401 before routing.
   Anonymous callers can't map the API, and the check doesn't depend on route discovery. With a valid
   session, Nitro's 404 goes through the error handler as `{ statusCode: 404, message: 'Not Found' }`.

**Second layer:** every protected handler starts with `const { userId } = requireAuth(event)`. If a path
quirk ever bypassed the middleware, the handler still returns 401. A unit test scans `server/api/**`
and fails if a handler that isn't on the allow-list doesn't call `requireAuth` (§8.1, U12).

### 6.3 Lint guardrails (`eslint.config.mjs`, backend)

- `no-restricted-syntax`: calls to `getUserSession`, `requireUserSession`, `setUserSession`,
  `replaceUserSession`, `clearUserSession` are banned in `server/**` except in
  `server/services/auth/session.ts` and `server/middleware/02.auth.ts`. This prevents anonymous cookies,
  TTL extension, and a second identity source.
- `useUserSession().clear` is banned in `app/**` (it calls the blocked route).
- `hashPassword`/`verifyPassword` only in `server/services/auth/**`.

### 6.4 Pages (`app/middleware/auth.global.ts`, frontend)

Pages are protected by default too. `definePageMeta({ auth: 'public' })` for `/` and the error page,
`{ auth: 'guest' }` for `/login` and `/register` (a signed-in user is redirected to `/dashboard`). Every
other page needs `loggedIn`; otherwise the user goes to `/login?redirect=<path>`, and after login
`navigateTo(safeRedirectPath(route.query.redirect))` (no open redirect). This is a UX layer only; the
server enforces access.

### 6.5 CSRF (D3)

`server/middleware/01.origin.ts`, for every method except GET, HEAD, and OPTIONS, on every path:

1. If `Sec-Fetch-Site` is present, it must be `same-origin`. `same-site`, `cross-site`, and `none` → 403.
2. If `Origin` is present, it must equal `runtimeConfig.appOrigin` exactly. Otherwise → 403.
3. If neither header is present → 403. Every browser that supports Nuxt 4 sends at least one of them on
   a POST, so only non-browser clients are affected, and they can send `Origin`.
4. On `/api/**`, a request with a body must be `Content-Type: application/json` (415). This blocks HTML
   form posts and `text/plain` "simple" requests. LEX-006 adds an explicit exception for the CSV upload route.

Together with `SameSite=Lax` (no cookie on cross-site subrequests), GET routes that never change state,
and no CORS, this covers login CSRF and cross-site POSTs. It also covers same-site sibling subdomains,
which `SameSite` alone does not. OWASP's CSRF cheat sheet lists Fetch Metadata and Origin verification
as a valid defense.

**Recommendation: don't enable nuxt-security's CSRF token (`nuxt-csurf`).** It adds a module, a token
cookie, a header on every `$fetch`, and SSR token plumbing, and it covers no request type that the
origin check misses. Architecture §8 A08 currently lists the token, so dropping it needs Alina's
approval. If D3 is rejected: set `security.csrf: true` and use `useCsrfFetch` in `app/**`. The origin
check stays either way.

### 6.6 Audit logging (`server/utils/audit.ts`, D10)

One JSON line per event on stdout, with no new dependency. The function signature restricts the fields,
so a request body or an arbitrary object can't be logged by mistake:

```ts
type AuditEvent =
  | 'auth.register.success' | 'auth.register.failure' | 'auth.login.success' | 'auth.login.failure'
  | 'auth.logout' | 'auth.session.invalid' | 'auth.rate_limited' | 'access.denied'
  | 'account.deleted' | 'account.delete.failure' | 'server.error'
audit(event: H3Event, name: AuditEvent, fields?: {
  userId?: string; email?: string /* hashed inside audit(), never written in clear */;
  reason?: 'invalid_credentials' | 'unknown_user' | 'duplicate_email' | 'policy' | 'validation' | 'expired'
         | 'idle' | 'revoked' | 'user_missing' | 'unauthenticated' | 'not_owner' | 'origin' | 'rate_limit';
  scope?: 'ip' | 'account' | 'register' | 'reauth'; resource?: AuditResource; statusCode?: number;
  errorName?: string; pgCode?: string;
})
// → {"ts":"…","level":"info|warn|error","event":"auth.login.failure","requestId":"…","route":"POST /api/auth/login",
//    "ip":"203.0.113.5","userId":null,"emailHash":"9f86d081884c7d65","reason":"unknown_user"}
```

- `emailHash` = first 16 hex characters of `HMAC-SHA256(deriveSecret('recallio:audit'), email)`. It
  links events for one email without storing the email.
- Never logged: passwords, hashes, cookies, `sid`, tokens, request bodies, `Authorization`/`Cookie`
  headers, stack traces, or error messages. 5xx errors log only `errorName` and `pgCode` (Postgres
  `detail` contains values).
- `JSON.stringify` escapes newlines, so log injection isn't possible.
- The IP is logged in clear for security events (D10). `docs/privacy.md` must document it, with the
  retention of the hosting provider's logs (LEX-017).

### 6.7 Central error handler (`server/error-handler.ts`, deferred A10 item)

`defineNitroErrorHandler`, prepended in `nitro:config` (§2.5). For `/api/**`:

- `status` = the error's status if it is one of 400, 401, 403, 404, 405, 409, 413, 415, 429, 503;
  everything else → 500.
- `message` = a fixed text per status ("Bad Request", "Unauthorized", …, "Internal Server Error"),
  unless the error was created by our `publicError(status, message, issues?)` helper (marked with a
  private symbol). Only those carry the route's own safe message, such as the 401 login message.
- `issues` only on 400, from `zodIssuesToPublic(err)`: the `path` plus the schema's fixed message. The
  submitted value is never echoed (D7).
- No URL, host, stack, `data`, or `statusMessage` reflection. The reason phrase is fixed. Headers set
  before the error (`Retry-After`, `Set-Cookie` from `clearUserSession`, `X-Request-Id`) are kept.
- 5xx errors are logged with `audit(…, 'server.error')`. Then the handler sets `event.handled`.

Other paths fall through to Nuxt's handler, which renders `app/error.vue`. That page shows only the
status and a fixed message, never `error.url` or `error.message` from the query.
**Security check:** confirm that `GET /__nuxt_error?statusCode=…&message=…` can't be used from outside
to render attacker text. If it can, `02.auth` returns 404 for external requests to that path.

---

## 7. Frontend (minimal; full navigation is LEX-015)

Nuxt UI v4 components only (`UForm`, `UFormField`, `UInput`, `USelect`, `UButton`, `UAlert`, `UModal`, `UCard`).

| Route        | Meta             | Content                                                                                                                                 |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | `auth: 'public'` | Existing landing page plus "Log in" and "Create account" links                                                                          |
| `/register`  | `auth: 'guest'`  | Email, password (with requirements text linked by `aria-describedby`), native language (French, English), hidden `timezone` from `Intl` |
| `/login`     | `auth: 'guest'`  | Email, password; generic error; 429 message with time left                                                                              |
| `/dashboard` | protected        | Placeholder `h1` "Dashboard", "Signed in as {email}" from `GET /api/auth/me`, "Log out" and "Account" links                             |
| `/account`   | protected        | "Delete account" section: explains what is deleted, password field, confirmation `UModal`, then `DELETE /api/account` → `/`             |

Components: `app/components/auth/PasswordInput.vue` (a `UInput` plus a toggle `UButton` with
`aria-pressed`, `aria-controls`, and the label "Show password"/"Hide password"; the input type switches
between `password` and `text`), `app/components/auth/FormErrorSummary.vue` (`UAlert` with `role="alert"`,
a heading, links to each field; it receives focus after a failed submit). Layout: `app/layouts/auth.vue`
(centered `UCard`, one column, `min-h-dvh`; `max-w-md` on desktop).

Accessibility (WCAG 2.2 AA): visible labels, never placeholder-only. `autocomplete` = `email`,
`new-password`, `current-password`. Email fields: `inputmode="email"`, `autocapitalize="none"`,
`spellcheck="false"`. Errors use text plus an icon, never color alone, and fields get `aria-invalid`.
Visible focus. Touch targets are at least 44 px (2.5.8). Nothing is lost if the user pastes (3.3.8,
accessible authentication). Submit buttons show a loading state with an accessible label. After
login/logout, focus moves to the new page's `h1` (`NuxtRouteAnnouncer` already exists). Client-side
validation uses the same shared schemas; server errors (`issues`, 401, 409, 429) map onto the same summary.

Logout: `$fetch('/api/auth/logout', { method: 'POST', body: {} })` → `await useUserSession().fetch()` →
`navigateTo('/login')`. A 401 from any API call during the session also leads to `/login`.

---

## 8. Tests

AC1 = protected endpoints return 401 without a session · AC2 = IDOR and auth abuse tests pass · AC3 =
passwords never logged or returned. US = US-AUTH-01 bullets.

### 8.1 Unit (`tests/unit`, `tests/security`; no DB)

| #   | Case                                                                                                                                                                                                                     | Covers   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| U1  | Policy table: 11 → `too_short`, 12 → ok, 128 ok / 129 `too_long` counted in **code points** (emoji, combining marks), NFKC (`ｐａｓｓ…` full-width = ASCII)                                                              | US, A07  |
| U2  | `contains_email` case-insensitive; local part < 3 characters is skipped; `repetitive` (`aaaaaaaaaaaa`, `abcdefghijkl`, `aabbaabbaabb` < 4 distinct); spaces and Unicode passwords accepted                               | A07      |
| U3  | Blocklist via an injected `has`: hit is case-insensitive; the real file loads, has ≥ 40,000 entries, all 12–128 characters, lowercase, unique; `NOTICE` exists                                                           | A07      |
| U4  | Schemas: unknown keys → error (`.strict()`) for all five; email trim + lowercase; 255-char email and 65-char local part rejected; `nativeLanguage: 'de'` rejected; bad timezone rejected; 1025-unit password rejected    | A05      |
| U5  | `publicUserSchema` has no `passwordHash`; the DTO mapper output equals the schema keys exactly                                                                                                                           | AC3      |
| U6  | `safeRedirectPath`: `//evil.example`, `/\evil`, `https://x`, `javascript:…`, `/%0d%0a`, non-strings → `/dashboard`; `/collections/1?x=1` kept                                                                            | A01      |
| U7  | `isPublicApiRoute`: exact matches; `HEAD /api/health` public; `/api/health/`, `/api/health?x` (query stripped → public), `/api/auth/login/`, `/API/health`, `POST /api/health`, `DELETE /api/_auth/session` → not public | AC1      |
| U8  | Origin check pure function: all combinations of `Sec-Fetch-Site` × `Origin` × method, including `null` origin and a trailing slash                                                                                       | A08      |
| U9  | Backoff: free attempts, doubling, 15-min cap, reset, 24-h TTL, `Retry-After` rounding                                                                                                                                    | A07      |
| U10 | Error mapping: an unknown error → 500 fixed message, no `stack`/`url`/`data` keys; `publicError` keeps its message; a Zod error → `issues` without input values                                                          | A10      |
| U11 | `audit()`: an email passed in comes out only as a 16-hex `emailHash`; unknown field keys are a type error (`expectTypeOf`); output is one line                                                                           | A09, AC3 |
| U12 | Static check: every file in `server/api/**` not on the allow-list contains `requireAuth(event)`; every allow-list entry matches a real file                                                                              | AC1      |
| U13 | env: built server without `appSecret`, with 31 characters, with the placeholder, with `NUXT_SESSION_PASSWORD`, with a non-https `appOrigin`, or `secure: false` → fails; messages never contain values                   | A02/A04  |

### 8.2 Integration (`tests/integration`, real Postgres, services called directly with `db`)

| #   | Case                                                                                                                                                                                  | Covers      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| I1  | Session store: create → valid; `expires_at` in the past → invalid; `last_seen_at` 8 days ago → invalid; touched only when older than 1 h; revoke one / all; cap of 10 per user; sweep | A07         |
| I2  | `createUser` duplicate (`A@x.fr` vs `a@x.fr`) → mapped to the `duplicate_email` result, not a thrown 23505                                                                            | US          |
| I3  | `deleteUser` as the app role removes the user's `user_sessions` and every other table (extends X1); a second user is untouched                                                        | §15 Privacy |
| I4  | Privilege matrix: `user_sessions` is SELECT, INSERT, DELETE, UPDATE(`last_seen_at`) only; the app can't update `user_id`, `expires_at`, `created_at`                                  | A01         |
| I5  | SRS isolation: the auth services don't import `schema/srs` (lint) and a full register → login → logout run leaves `srs_*` unchanged                                                   | Rule 1      |

### 8.3 API black-box (new Vitest project `api`, D9)

`tests/api/global-setup.ts`: take the integration run lock, reset and migrate `recallio_test` (reuse
the integration setup), build if `.output` is missing or stale, spawn `node .output/server/index.mjs` on
a random port with `NUXT_DATABASE_URL` = the test app URL, a test `NUXT_APP_SECRET`, `NUXT_APP_ORIGIN`,
and **`NUXT_TRUSTED_IP_HEADER=x-test-client-ip`**, wait for `/api/health`, capture stdout and stderr to
a file, kill the server at teardown. Each test sends a unique documentation IP (`198.51.100.x`,
`2001:db8::x`) in that header, so rate-limit buckets don't interfere and no test-only bypass exists in
the app. A small cookie-jar `fetch` client sends `Origin` on mutating requests.

| #   | Case                                                                                                                                                                                                                                                                  | Covers        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| A1  | Journey: register (201, `Set-Cookie` has `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000`, no `Domain`) → me → logout (204) → login → me → delete → me 401                                                                                | US            |
| A2  | **Every protected route without a session → 401**, generated from the `server/api/**` file list (so later routes are covered automatically); unknown `/api/nope` → 401; with a session → 404                                                                          | AC1           |
| A3  | Enumeration: login with an unknown email vs a wrong password → identical status, body, and header set (except `X-Request-Id`); response times within a tolerance over 20 runs each (both run one scrypt)                                                              | AC2, A07      |
| A4  | Brute force: 20 failures from one IP → 429 with `Retry-After`; account backoff across 5 rotating IPs: the 6th attempt → 429 with `Retry-After`. Backoff timing is covered by U9, since a black-box test cannot fake the clock                                         | AC2           |
| A5  | Backoff doesn't reveal existence: the same sequence on a registered and an unregistered email gives the same statuses                                                                                                                                                 | AC2           |
| A6  | Session fixation: (a) an attacker's own valid cookie sent with the victim's login → the response cookie differs, the attacker's old cookie now → 401 (its row is deleted); (b) a forged or garbage cookie → treated as anonymous, cleared                             | AC2           |
| A7  | Logout revocation: copy the cookie, log out, replay the copy → 401 + clearing `Set-Cookie`. `scope: 'all'` → a second device's cookie → 401                                                                                                                           | AC2, A07      |
| A8  | Deleted user's cookie → 401; `/api/_auth/session` returns `{}`                                                                                                                                                                                                        | AC2           |
| A9  | Timeouts: set `last_seen_at` back 8 days (migrator) → 401; set `expires_at` to the past → 401                                                                                                                                                                         | A07           |
| A10 | CSRF: POST login/logout/delete with `Origin: https://evil.example` → 403; `Sec-Fetch-Site: cross-site` → 403; `same-site` → 403; no Origin and no Sec-Fetch-Site → 403; `text/plain` and form bodies → 415; `DELETE /api/_auth/session` → 404                         | AC2, A08      |
| A11 | IDOR: user A's cookie on `DELETE /api/account` with `{ userId: B }` → 400 (strict); B still exists. Reusable `expectIdor(route, setupA, setupB)` helper for LEX-004+ (expects 404)                                                                                    | AC2, A01      |
| A12 | Oversized and malformed input: 1.1 MB body → 413; 255-char email → 400; 129-code-point password at register → 400 with `issues`; 1025 units at login → 400; JSON array body → 400; invalid JSON → 400; error bodies match `apiErrorSchema` and contain no input value | AC2, A05, A10 |
| A13 | **Passwords never logged or returned:** after A1–A12, the captured server log contains none of the test passwords, emails, cookie values, or `$scrypt$`; no response body anywhere contains `password` or `passwordHash` keys (deep scan)                             | **AC3**       |
| A14 | Audit: the log has one JSON line per expected event with `requestId` matching the response's `X-Request-Id`                                                                                                                                                           | A09           |
| A15 | Error handler: 404/405/500 bodies are exactly `{ statusCode, message }`; no request URL or Host in the body; `Cache-Control: no-store` on `/api/**`                                                                                                                   | A10, A02      |
| A16 | Registration duplicate → 409 with the fixed message; the existing account's password hash is unchanged                                                                                                                                                                | D4            |
| A17 | Icons load from `/_nuxt_icon/...` without a session                                                                                                                                                                                                                   | regression    |

### 8.4 E2E (Playwright, desktop + mobile projects; axe on every page and on error states)

- **Journey:** `/register` → `/dashboard` (shows the email) → log out → `/login` → `/dashboard` → `/account`
  → delete (modal, password) → `/` → logging in with the old credentials shows the generic error.
- Protected redirect: `/dashboard` logged out → `/login?redirect=%2Fdashboard` → back after login.
  `?redirect=//evil.example` → `/dashboard`.
- Errors: submit an empty form → the error summary gets focus, fields have `aria-invalid`, axe passes;
  a weak password shows the policy message as text.
- Keyboard only (desktop): tab order, Enter submits, the password toggle works with Space/Enter and
  announces its state.
- Mobile: no horizontal scroll at 320 CSS px; controls ≥ 44 × 44 px; the focused input stays visible.
- The CSP test from LEX-001 also runs on `/login` and `/register` (no violations; the nonce applies to
  Nuxt UI).
- E2E uses `recallio_test` (migrated by the Playwright global setup under the same run lock), so it
  doesn't run at the same time as `test:integration` or `api`.

---

## 9. Decisions needed (recommendations)

| #   | Question                                | Options                                                                                                                                                                                                                                                                  | Recommendation                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **nuxt-auth-utils version and secret**  | (a) `0.6.2` exact: Nuxt ≥ 4.6 (we have 4.6.4), secret `NUXT_APP_SECRET`. The 0.6 line is new (0.6.0 on 2026-10-30, 0.6.2 on 2026-11-06). (b) `0.5.34`: legacy API, `NUXT_SESSION_PASSWORD`, a forced migration later that logs everyone out                              | **(a) `0.6.2`, pinned exactly**, with `NUXT_APP_SECRET` validated at boot. `NUXT_SESSION_PASSWORD` is **not** used: the issue text predates 0.6. Our design relies only on documented behaviour (§1.2), and it's covered by tests A1, A6, and A7. Architecture §8 A04 wording changes to "`NUXT_APP_SECRET`". |
| D2  | **Session revocation (data model)**     | (A) `user_sessions` table (migrations 0005 + 0006). (B) `users.session_version` (logout = everywhere). (C) stateless only                                                                                                                                                | **(A).** Exact per-device logout (ASVS V7.4.1), server-side idle and absolute timeouts, and deleted-user handling for the same one query per request that B also needs. C fails ASVS and still needs a user lookup for deleted users.                                                                         |
| D3  | **CSRF token**                          | (a) no token: SameSite=Lax + Sec-Fetch-Site/Origin + JSON-only. (b) also enable `nuxt-csurf` via nuxt-security                                                                                                                                                           | **(a)**, and update architecture §8 A08. The token adds plumbing and covers no extra request type (§6.5).                                                                                                                                                                                                     |
| D4  | **Registration with an existing email** | (a) 409 with a fixed message, enumeration via register accepted and rate-limited. (b) always respond like success without a session, then ask to log in. Still enumerable (register, then try login) and confusing                                                       | **(a).** Without an email channel, registration can't hide whether an account exists (OWASP Authentication Cheat Sheet). Login, backoff, and timing stay non-enumerating. Mitigations: 10/h per IP, same work on both paths, audit.                                                                           |
| D5  | **Password blocklist source**           | (a) SecLists xato 1M + NCSC 100k, filtered to ≥ 12 characters: 46,888 entries, 686 KB, server-only, MIT. (b) the top 10k (only 10 usable entries). (c) HIBP API                                                                                                          | **(a)**, generated by a committed script from a pinned commit, with a NOTICE file. HIBP can come later.                                                                                                                                                                                                       |
| D6  | **scrypt parameters**                   | (a) N=2^14, r=8, p=5 (OWASP equivalent, 16 MiB, ~115 ms). (b) library default p=1 (below OWASP's minimum). (c) N=2^17, p=1 (128 MiB per login)                                                                                                                           | **(a)**. Re-measure on the production host in LEX-017. Existing hashes migrate through `passwordNeedsReHash`.                                                                                                                                                                                                 |
| D7  | **Error body**                          | (a) `{ statusCode, message }` only. (b) plus optional `issues: [{ path, message }]` on 400, with fixed schema messages                                                                                                                                                   | **(b).** The server-only blocklist and policy checks need to point at the right field. No input values are echoed.                                                                                                                                                                                            |
| D8  | **Cookie name**                         | `nuxt-auth-session` (default) or `__Host-recallio-session`                                                                                                                                                                                                               | **`__Host-`**: it forces `Secure`, `Path=/`, no `Domain`, and blocks cookie planting from subdomains. Works on `http://localhost` in Chromium and Firefox.                                                                                                                                                    |
| D9  | **How to test Nitro handlers**          | (a) a new `api` Vitest project that spawns the built server once, with a trusted IP header per test. (b) `@nuxt/test-utils` `setup({ server: true })` per file (a build per file, slow). (c) calling handlers with fake h3 events (skips the middleware we need to test) | **(a)**, plus services that take `db` for direct integration tests.                                                                                                                                                                                                                                           |
| D10 | **Logger and IPs in logs**              | (a) our own `audit()` JSON to stdout, IP in clear, email as an HMAC. (b) add `pino`. (c) hash IPs too                                                                                                                                                                    | **(a).** No new dependency. IPs are needed to investigate abuse. Document it in `docs/privacy.md` (legitimate interest, the hosting provider's log retention).                                                                                                                                                |

Small decisions I made (tell me if you disagree): `@nuxt/icon` endpoint moved to `/_nuxt_icon`;
unknown `/api/**` routes answer 401 to anonymous callers; optional `timezone` captured at registration
from the browser; `DELETE /api/_auth/session` blocked; 10 active sessions per user; no permanent lockout;
password re-entry for account deletion uses 403 so the client doesn't treat it as "signed out";
`Cache-Control: no-store` on all API responses.

---

## 10. Files and owners

| File                                                                                                                                                                                                                                            | Action        | Owner                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------- |
| `package.json`, `pnpm-lock.yaml` (`nuxt-auth-utils@0.6.2` exact; commit `build(deps): pin nuxt-auth-utils 0.6.2`)                                                                                                                               | modify        | backend                                       |
| `nuxt.config.ts` (§2.5), `.env.example`, `playwright.config.ts` (webServer env), `vitest.config.ts` (`api` project), `eslint.config.mjs` (§6.3)                                                                                                 | modify        | backend (config); tester for the test configs |
| `shared/schemas/auth.ts`, `shared/auth/password-policy.ts`, `shared/auth/redirect.ts`, `shared/types/auth.d.ts`                                                                                                                                 | create        | backend                                       |
| `server/db/schema/sessions.ts`, `server/db/schema/index.ts`                                                                                                                                                                                     | create/modify | backend                                       |
| `server/db/migrations/0005_*.sql` (generated), `0006_auth_grants.sql` (custom), `meta/*`                                                                                                                                                        | create        | backend                                       |
| `server/utils/env.ts`, `server/plugins/00.env.ts`                                                                                                                                                                                               | modify        | backend                                       |
| `server/plugins/03.request-context.ts`, `04.auth-boot.ts` (dummy hash, blocklist load, limiter prune, session sweep)                                                                                                                            | create        | backend                                       |
| `server/middleware/01.origin.ts`, `server/middleware/02.auth.ts`                                                                                                                                                                                | create        | backend                                       |
| `server/utils/{auth,authz,public-routes,audit,errors}.ts`, `server/error-handler.ts`                                                                                                                                                            | create        | backend                                       |
| `server/services/auth/{session,password,rate-limit,users}.service.ts` (or `.ts`), `server/services/auth/counter-store.ts`                                                                                                                       | create        | backend                                       |
| `server/api/auth/{register.post,login.post,logout.post,me.get}.ts`, `server/api/account.delete.ts`                                                                                                                                              | create        | backend                                       |
| `server/assets/password-blocklist.txt`, `server/assets/password-blocklist.NOTICE`, `scripts/build-password-blocklist.ts`                                                                                                                        | create        | backend                                       |
| `app/middleware/auth.global.ts`, `app/layouts/auth.vue`, `app/layouts/default.vue`, `app/error.vue`                                                                                                                                             | create        | frontend                                      |
| `app/pages/{register,login,dashboard,account}.vue`, `app/pages/index.vue` (links)                                                                                                                                                               | create/modify | frontend                                      |
| `app/components/auth/{PasswordInput,FormErrorSummary}.vue`                                                                                                                                                                                      | create        | frontend                                      |
| `tests/unit/**` (U1–U13), `tests/integration/**` (I1–I5, factory `createSession`, X1/matrix updates), `tests/api/**` (A1–A17), `tests/e2e/auth.spec.ts`                                                                                         | create/modify | tester (abuse cases with security)            |
| `docs/architecture.md` §2 (`server/assets`, `tests/api`), §4 (`user_sessions`), §8 A04/A07/A08/A09/A10 + "Error responses", §12 log; `docs/privacy.md` (sessions, audit logs and IPs); README (env vars, `pnpm test:api`); CLAUDE.md "Commands" | modify        | docs                                          |

---

## 11. Risks and invariants

1. **SRS isolation (rule 1):** auth never imports SRS code. Account deletion removes SRS rows only through
   the owner cascade, which ADR 0001 X1 already proves; I3 extends it to `user_sessions`.
2. **Ownership (rule 5):** `event.context.auth.userId` is the only identity source. Bodies never carry a
   user id (strict schemas reject it). Later issues use owner-scoped queries plus `requireOwner()` → 404,
   with the `expectIdor` helper.
3. **Fail closed:** the middleware and `requireAuth()` are two independent layers. Any session check error
   (DB down) → 401 or 503, never anonymous access to a protected route. The allow-list uses exact matches.
4. **Young dependency:** nuxt-auth-utils 0.6 is 9 days old and depends on Nuxt 4.6's new `nuxt/server`
   session API, whose doc says "the sealed cookie format may change in a minor release". Mitigation: exact
   pins for nuxt-auth-utils, tests A1/A6/A7/A8 on real cookies, and a review of every upgrade.
5. **In-memory limiter:** per process, lost on restart, and counters can be evicted when the 100k-key cap
   is reached under a distributed attack. Bounded by the global per-IP limiter. It must move to Redis with
   atomic increments before a second instance (LEX-017). The same applies to nuxt-security's LRU store.
6. **Victim lockout:** an attacker can keep a known email in backoff (at most 15-minute waits). Accepted,
   because a permanent lockout would be worse without password reset. Visible in the audit log.
7. **Registration enumeration (D4):** accepted residual risk, rate-limited and logged.
8. **scrypt CPU and memory:** 16 MiB and about 115 ms per hash. Bounded by the libuv pool (4), the per-IP
   limits, and limits checked before hashing. Optional semaphore (§5.2).
9. **Anonymous cookies:** any direct call to the session helpers would create cookies and could extend the
   TTL. Blocked by the lint rule in §6.3.
10. **Clock:** timeouts use the database clock (`now()`), so app-server clock drift doesn't matter. The
    iron TTL uses the app clock and is only the second layer.
11. **CSP:** Nuxt UI components on the new pages must work with the nonce CSP (tested in E2E).
12. **Accessibility:** forms must pass axe and keyboard tests on both projects. Error feedback uses text,
    icons, and `aria-invalid`, never color alone (rule 6). Accessible authentication (WCAG 3.3.8): paste
    and password managers allowed, no cognitive tests.
13. **No account recovery:** a forgotten password means a lost account (decision #5). The UI says so on
    `/register` in plain words, and the README documents it.

---

## 12. Consequences

- **Positive:** one identity source; deny by default on two layers; real logout; exact timeouts; no
  personal data in the cookie; no new runtime dependency except nuxt-auth-utils; every later route is
  automatically covered by the 401 sweep (A2) and gets the `requireOwner`/`expectIdor` tools.
- **Negative:** a session lookup on every authenticated API request (one indexed query, plus at most one
  write an hour); a new table and two migrations; a 686 KB data file in the repo; a new `api` test
  project that needs a build and Docker; E2E and integration runs share `recallio_test` and can't run in
  parallel.
- **Follow-ups:** LEX-015 (navigation and account settings), LEX-017 (Redis for limiter counters, scrypt
  benchmark on the host, log retention, `NUXT_APP_SECRET` and `NUXT_APP_ORIGIN` in the secret store, CI
  Postgres service for `api` tests), a later release (password change and reset, which will reuse
  "revoke all sessions").

---

## 13. Implementation notes (2026-11-09)

Where the implementation differs from the text above, and why:

1. **Middleware location.** Nitro runs scanned `server/middleware/*` before every module handler, so
   `02.auth` would have done its DB lookup before nuxt-security's global rate limiter (§3 requires the
   opposite). The origin and auth middleware live in `server/handlers/01.origin.ts` and
   `server/handlers/02.auth.ts` and are registered by a small inline module in `nuxt.config.ts`, listed
   after nuxt-security. Built-server order: static assets → `00.db-role` → nuxt-security (size limit,
   CORS, methods, rate limiter, XSS validator) → `01.origin` → `02.auth` → router. The lint exception
   in §6.3 points at the new path.
2. **Boot validation** is a separate `authConfigSchema` / `validateAuthConfig()` in `server/utils/env.ts`
   next to `serverConfigSchema` (whose callers pass only the database URL). Built servers also reject a
   session cookie name without `__Host-` and a `maxAge` over 30 days.
3. **Unknown API routes with a session** are answered by `server/api/[...path].ts` (`requireAuth`, then
   404), so they don't fall through to the page renderer.
4. **nuxt-security's XSS validator is off on `/api/auth/register`, `/api/auth/login` and `/api/account`**:
   it rejected passwords containing markup such as `<script>` with a 400, which contradicts §5.3 (any
   characters allowed). These routes return JSON and never echo input.
5. **Blocklist:** 46,825 entries (not 46,888): entries are NFKC-normalized like the lookup, and lines
   with control characters are dropped. The script pins the SHA-256 of both upstream files.
6. **Service name:** a password containing `recallio` is reported with the `common` code and message.
7. **Audit reasons** gain `malformed` (a cookie that unseals but lacks `user.id`/`secure.sid`), and
   `scope` gains `current`/`all` for `auth.logout`.

### 13.1 Review fixes (2026-11-09)

8. **H1, limiters hold under parallel requests.** Every auth limit is checked _and_ booked in one
   serialized `store.update` before the password is checked: login books a pending failure on the
   account key (failures + 1, lastFailureAt = now) and an attempt in the IP window, then clears the
   backoff and refunds the IP slot on success (a 429 on the account key also refunds the IP slot).
   Account deletion books its re-authentication failure the same way. Registration already did this
   (`consumeWindow`). A burst of 15 parallel guesses on one account evaluates at most 5.
9. **M1, IPv6 /64.** Per-IP keys count the rate-limit subject (`rateLimitSubject()` in
   `server/utils/client-ip.ts`): the IPv4 address (IPv4-mapped addresses unwrapped) or the IPv6 /64 as
   `a:b:c:d::`. The same subject is written to `X-Forwarded-For` for nuxt-security's global limiter.
   Audit logs keep the full address.
10. **M2, store caps.** The counter store caps backoff keys and window keys separately (50,000 each).
    Nothing is evicted: when a family is full, new keys of that family are refused, and the limiter
    answers 429 with `Retry-After: 60` until the next prune frees expired entries. A flood of per-IP
    keys can no longer erase an account's backoff. Registration creates its counter key only after
    the blocklist check passes (Zod's shape and policy run before the service).
11. **L1.** The module-route block matches the normalized path (decoded, backslashes and repeated or
    trailing slashes collapsed, case-folded, no query) for every method except GET and HEAD.
12. **L2.** The error handler also answers every `/__nuxt_error` error and every other error Nuxt would
    have answered with JSON (same test as Nuxt's `isJsonRequest`), with the fixed body only: no URL or
    Host reflection. HTML page errors still go to Nuxt's handler.
13. **L3, icons.** `icon.fallbackToApi: false`, a local server bundle, and a client bundle (scan plus
    Nuxt UI's default icons). The data comes from the new devDependency `@iconify-json/lucide`
    (1.2.152, ISC, build-time only). Before this, icons were fetched from `api.iconify.design` by the
    server at runtime. Checked in Chromium: eye, eye-off and loader-circle render with no external
    request and no CSP violation.
14. **Schema contract.** `nativeLanguage` has the fixed message "Choose your native language."
    (`AUTH_MESSAGES.nativeLanguage`); `languageCodeSchema` has "Choose a supported language.". The
    password policy refinement runs whenever the password itself parsed, even if other fields are
    invalid (Zod 4 `when`). An invalid email (including empty or blank) yields exactly one issue.
15. **Zod JIT off.** `shared/zod.ts` calls `z.config({ jitless: true })` and re-exports `z`. Zod probes
    `new Function('')` when the first object schema is _constructed_, so every module in `shared/` and
    `server/` imports `z` from there (lint rule `recallio/no-direct-zod`).
16. **`HEAD /api/health`** has its own route file (the h3 router does not fall back from HEAD to GET)
    sharing the GET handler; it is public through the HEAD→GET rule of `isPublicApiRoute`.
17. **NOTICE** adds the Open Government Licence v3.0 attribution for the NCSC list and notes that the
    Burnett dataset was released publicly without a formal licence.
