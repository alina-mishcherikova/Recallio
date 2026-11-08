# CLAUDE.md — Recallio

Recallio is a vocabulary-learning web app: FSRS spaced repetition plus independent practice modes.
- Product spec: `docs/spec.md` (source of truth for behavior and acceptance criteria)
- Architecture: `docs/architecture.md` (stack, structure, data model, rules)
- Decisions: `docs/decisions/` (ADRs)

## Stack
Nuxt 4 full-stack (Vue 3, Nitro server routes) · TypeScript strict · PostgreSQL + Drizzle · Zod ·
nuxt-auth-utils · ts-fsrs v6 (exact version pinned) · Vitest + Playwright · Node ≥ 24 · pnpm.

## Commands
Added in LEX-001. Keep this section up to date: dev, db:up, db:migrate, lint, typecheck, test, test:e2e.

## Non-negotiable rules
1. **No silent FSRS updates.** Only `server/services/srs/review.service.ts` writes `srs_cards` /
   `srs_review_logs`, and only through `POST /api/review/submit`. Practice, test, and guided modes
   never import SRS write code. Every practice mode needs a regression test proving SRS is unchanged.
2. **Review submission is atomic and idempotent** (`clientReviewId`, row lock, single transaction).
3. **No invented correctness.** Answers are checked deterministically against stored, validated data.
   Unknown answers are never auto-accepted. No generative AI in exercise logic.
4. **No misleading metrics.** Practice accuracy ≠ FSRS retention. Keep them separate in storage and UI.
5. **Ownership everywhere.** Every query is scoped to the session user. Other users' resources → 404.
6. **Accessibility:** WCAG 2.2 AA. Feedback never relies on color alone. Keyboard and touch both work.
7. **Security by default.** OWASP Top 10 (2025) + ASVS L2. Controls are in `docs/architecture.md` §8.
   - Deny by default: every `/api/**` route requires a session unless it's on the public allow-list.
   - Zod `strict()` validation for every body, query, and param. Never trust the client.
   - Parameterized queries only (no `sql.raw`). No `v-html`, no `eval`.
   - Never log or return secrets, passwords, tokens, or stack traces. Secrets come only from env.
   - New dependencies must be justified. Keep the lockfile committed. `pnpm audit` stays clean.
   - The `security` agent reviews every PR. Critical or High findings block merging.

## Languages
ISO 639-1 codes with an allow-list in `shared/constants/languages.ts`. At launch: `fr`, `en`.
No email verification or password reset in the MVP.

## Code conventions
- Layering: `server/api` (Zod-parse, call service) → `server/services` (logic) → `server/db`.
- Code shared by client and server goes in `shared/` (schemas, answer engine, enums).
- Language direction is always explicit: `recognition` (target→native) / `production` (native→target).

## Git workflow (always)
- Never commit to `main`. One branch per issue: `feat/lex-004-collections-api`, `fix/...`,
  `chore/...`, `hotfix/...`, `release/...` (Conventional Branch, kebab-case).
- Conventional Commits: `type(scope): summary`, footer `Refs: LEX-xxx`.
- Push and open a PR with `gh pr create` (body: summary, test plan, `Closes #n`). Alina reviews and merges.

## Working with Alina
- Ask before architecture, library, or data-model decisions. Make small decisions yourself and mention them.
- Use the agents in `.claude/agents/`: architect → backend ∥ frontend → tester ∥ security → docs.
- UI: Nuxt UI v4 components first. Build custom components only when Nuxt UI lacks one.
