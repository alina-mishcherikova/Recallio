# Recallio

Vocabulary learning web app: FSRS spaced repetition plus independent practice modes
(typing, multiple choice, and more). Desktop and mobile web.

- Product spec: [`docs/spec.md`](docs/spec.md)
- Architecture and security baseline: [`docs/architecture.md`](docs/architecture.md)

## Requirements

- **Node.js 24 LTS** (see `.nvmrc`; Node 26+ also works). Odd-numbered releases such as Node 25 are not supported.
- **pnpm 12** (`corepack enable` installs the version pinned in `package.json`)
- **Docker** (local PostgreSQL 17)

## Setup

```bash
pnpm install
cp .env.example .env        # then change every password and keep the URLs in sync
pnpm db:up                  # start PostgreSQL in Docker (bound to 127.0.0.1)
pnpm db:migrate             # apply migrations
pnpm dev                    # http://localhost:3000
```

**Existing clones (one-time, from LEX-002):** the database now uses separate roles, created only on a
fresh volume. Recreate `.env` from `.env.example`, then run `pnpm db:reset`. This **deletes all local
data**. Do the same whenever you change a password or role in `.env`.

`pnpm dev` and drizzle-kit read `.env` automatically. `pnpm test:e2e` runs the built server, which doesn't, so
export the variables first: `set -a; . ./.env; set +a`.

## Commands

| Command                             | What it does                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Dev server with HMR                                                                       |
| `pnpm build` / `pnpm preview`       | Production build / preview it                                                             |
| `pnpm db:up` / `pnpm db:down`       | Start / stop local PostgreSQL                                                             |
| `pnpm db:generate`                  | Generate a migration from `server/db/schema` changes                                      |
| `pnpm db:migrate`                   | Apply migrations                                                                          |
| `pnpm db:reset`                     | Delete the local DB volume, start PostgreSQL, and re-apply migrations (**deletes data**)  |
| `pnpm db:studio`                    | Drizzle Studio (browse the local DB)                                                      |
| `pnpm lint` / `pnpm lint:fix`       | ESLint (Nuxt + security rules)                                                            |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                  |
| `pnpm typecheck`                    | `vue-tsc` via `nuxt typecheck`                                                            |
| `pnpm test`                         | Vitest: `unit` (Node) and `nuxt` (Nuxt runtime) projects                                  |
| `pnpm test:integration`             | Vitest integration project against real PostgreSQL (needs Docker via `pnpm db:up`)        |
| `pnpm test:e2e`                     | Playwright on desktop and mobile, with axe accessibility checks (builds the app first)    |
| `pnpm audit:prod`                   | Dependency audit; fails on high or critical findings                                      |
| `pnpm check`                        | format check + lint + typecheck + unit tests (no integration tests; run those separately) |

## Environment variables

| Name                                                                    | Purpose                                                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_DATABASE_URL`                                                     | Runtime connection, as the DML-only app role. A built server refuses to start with a role that can run DDL. A non-local DB **must** use exactly one `sslmode=verify-full`. |
| `DATABASE_MIGRATOR_URL`                                                 | Migrations only (drizzle-kit). Migrator role; never read by the server.                                                                                                    |
| `TEST_DATABASE_URL` / `TEST_DATABASE_MIGRATOR_URL`                      | Integration tests. The database name must end in `_test`: it is wiped on every run.                                                                                        |
| `RECALLIO_MIGRATOR_PASSWORD` / `RECALLIO_APP_PASSWORD`                  | Passwords for the two DB roles, set when the local Docker database is first created                                                                                        |
| `NUXT_TRUSTED_IP_HEADER`                                                | Optional. Client-IP header set by your reverse proxy (e.g. `fly-client-ip`). Only set it if the proxy always overwrites that header.                                       |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Local Docker database only                                                                                                                                                 |

The server validates its configuration at startup and refuses to start if it's invalid. Every built
server (`pnpm build`) applies the production rules, whatever `NODE_ENV` says. Only `pnpm dev` is relaxed.

## Project layout

```
app/        Nuxt client: pages, components, composables
server/     Nitro API routes, services, Drizzle schema + migrations
shared/     Code used by client and server: schemas, answer engine
tests/      unit/, nuxt/, e2e/
docs/       Specification, architecture, decisions
.claude/    Claude Code agents and hooks used to develop this project
```

## Known limitations (MVP)

- There is no email verification or password reset, so a forgotten password can't be recovered.
