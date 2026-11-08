# 0001 — Database schema, SRS guard trigger, and least-privilege roles (LEX-002)

- **Status:** Accepted (2026-11-08). Final decisions in §7: D1 approved · D2 rejected · D3 = (b) · D4 = B ·
  D5–D10 approved. Amended before merge with the security and tester review fixes and the synonym and
  sentence-example tables (§7a). This record describes what was implemented in LEX-002.
- **Date:** 2026-11-08
- **Issue:** LEX-002 (#3), branch `feat/lex-002-database-schema`
- **Inputs:** `docs/spec.md` §4–5, §13–15 · `docs/architecture.md` §4, §5, §8 · `CLAUDE.md` rules 1, 2, 5, 7
- **Verified against:** ts-fsrs 6.0.0 (`node_modules`, runtime probe) and a throwaway Postgres 17.11
  container (trigger, privilege, and cascade behaviour in §3 and §4 was executed, not assumed)

---

## 1. Context

LEX-002 creates every MVP table from architecture §4, the SRS database guard (architecture §5, layer 3),
and a least-privilege runtime role (architecture §8). Issue acceptance criterion: _migrations apply on
an empty DB; constraint and trigger tests pass._ No API routes and no UI are part of this issue.

### 1.1 Scope (stories and criteria this issue serves at the data layer)

| ID            | Criterion supported by the schema                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec §14.1    | All MVP entities (User, Collection, VocabularyEntry, VocabularyMeaning, AcceptedAnswer, SrsCard, SrsReviewLog, PracticeAttempt)                                                                             |
| Spec §14.2    | Cards unique by user/entry/direction · idempotent submission · atomic transition + log · practice cannot modify SRS · ownership · language changes don't invalidate cards · revisions don't corrupt history |
| US-VOC-01     | Title, native and target language required · languages differ · description, topic · archive (`archived_at`)                                                                                                |
| US-VOC-02     | `revision` counter · editing doesn't reset FSRS (no FK action touches `srs_cards`) · no reset path in the MVP (D3)                                                                                          |
| US-VOC-03     | "Importing cannot overwrite existing FSRS history" — card INSERT must be pristine, `ON CONFLICT DO UPDATE` is blocked                                                                                       |
| US-VOC-04     | Answers attached to a meaning of the **same** entry (composite FK) · per-answer language · normalization config · `answer_change_log`                                                                       |
| US-TYP-03     | `answer_flags` (user flags a rejected answer); `normalized_text` can never be empty (no auto-accept of empty input)                                                                                         |
| US-SRS-01     | States new/learning/review/relearning · ratings Again/Hard/Good/Easy · persisted due date and memory state · log with timestamp and rating                                                                  |
| US-SRS-02     | Two independent cards per entry (`direction` in the unique key)                                                                                                                                             |
| US-SRS-03     | Backend enforcement (trigger + grants) · duplicate submissions rejected (`UNIQUE(client_review_id)`)                                                                                                        |
| US-SRS-04     | `daily_new_limit`, `daily_review_limit`, `timezone` on users                                                                                                                                                |
| §15 Privacy   | Account deletion hard-deletes every user-owned row in one statement (cascade chain, §2.3)                                                                                                                   |
| US-ANA (sep.) | FSRS reviews (`srs_review_logs`) and practice (`practice_attempts`) stored separately                                                                                                                       |

### 1.2 What ts-fsrs 6.0.0 actually produces

Architecture §4 was written against the legacy ts-fsrs card. In 6.0.0 the legacy `fsrs()`/`Card` API is
`@deprecated`; the supported API is `DefaultScheduler()`, which defaults to **FSRS-7**. Probe output
(`scheduler.newCard` / `scheduler.review`):

| ts-fsrs field (FSRS-7) | Type / observed values                | Column                             | Note                                                   |
| ---------------------- | ------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `cardId`               | string                                | `id`                               | We pass our UUID in as `cardId`.                       |
| `state`                | `State` 0..3                          | `state` (enum)                     | New/Learning/Review/Relearning                         |
| `scheduleStatus`       | `'new' \| 'learning' \| 'review'`     | `schedule_status` (enum) **new**   | Not derivable from `state` (Relearning → `'learning'`) |
| `dueAt`                | Date                                  | `due_at`                           |                                                        |
| `lastReviewAt`         | Date \| null                          | `last_review_at`                   |                                                        |
| `stability`            | float                                 | `stability`                        |                                                        |
| `stabilityFast`        | float (FSRS-7 only; absent in FSRS-6) | `stability_fast` **new**, nullable | Needed for lossless storage and for `forgettingCurve`  |
| `difficulty`           | float                                 | `difficulty`                       |                                                        |
| `scheduledDays`        | **fractional** float (e.g. `4.7777…`) | `scheduled_days` double            | FSRS-7 uses `fractionalDays: true`                     |
| `learningStep`         | int                                   | `learning_steps`                   | Approved name kept; maps to `learningStep`             |
| `reps`, `lapses`       | int                                   | `reps`, `lapses`                   |                                                        |
| — (`elapsed_days`)     | **does not exist** in ts-fsrs 6       | **dropped** (D1)                   | Derivable from `last_review_at`                        |

The revlog returned by `review()` is the **pre-review card** plus `rating` and `reviewTime`. So
`previous_state` (jsonb snapshot of the pre-review card), `rating`, and `reviewed_at` reconstruct it
exactly, and `next_state` holds the post-review card. The jsonb snapshots make logs lossless across scheduler versions.
`Rating` has `Manual = 0` in addition to Again..Easy. It is **not stored** (D2 rejected): there is no
reset path (D3 = b), so a log row always records a real review. The API is async in 6.0.0
(`await DefaultScheduler()`), and `review()` takes `{ card, grade, now }`.

---

## 2. Contracts

### 2.1 Shared constants and Zod (`shared/`, backend-owned; single source for pgEnums and Zod)

```ts
// shared/constants/languages.ts
export const LANGUAGE_CODES = ['fr', 'en'] as const // launch allow-list (decision #3)
export type LanguageCode = (typeof LANGUAGE_CODES)[number]

// shared/constants/enums.ts — order of SRS_STATES / SRS_RATINGS matches ts-fsrs numeric enums
export const DIRECTIONS = ['recognition', 'production'] as const
export const SRS_STATES = ['new', 'learning', 'review', 'relearning'] as const // State 0..3
export const SRS_SCHEDULE_STATUSES = ['new', 'learning', 'review'] as const
export const SRS_RATINGS = ['again', 'hard', 'good', 'easy'] as const // Rating 1..4 (no Manual, D2)
export const EXERCISE_TYPES = ['typing', 'multiple_choice'] as const // R2/R3 values added by migration
export const PRACTICE_SOURCE_MODES = ['typing', 'multiple_choice', 'difficult_words'] as const
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const // answer_flags now, sentence_examples in R2
export const ANSWER_CHANGE_ACTIONS = ['create', 'update', 'delete'] as const

// shared/constants/languages.ts also exports the schema (D5)
export const languageCodeSchema = z.enum(LANGUAGE_CODES)

// shared/schemas/common.ts (re-exports languageCodeSchema)
export const directionSchema = z.enum(DIRECTIONS)
export const reviewRatingSchema = z.enum(SRS_RATINGS)
// ... one z.enum per tuple above
```

Schema files must import these with **relative paths** (`../../../shared/constants/enums`) because
drizzle-kit loads the schema outside Nuxt and cannot resolve `#shared`.

### 2.2 API routes

None in LEX-002. There is no reset endpoint (D3 = b): `POST /api/review/submit` stays the only SRS write path.

### 2.3 Drizzle tables (`server/db/schema/*.ts`)

Conventions: PKs are `uuid` with `defaultRandom()` (`gen_random_uuid()`; PG17 has no `uuidv7()`).
Timestamps are `timestamptz` (`{ withTimezone: true, mode: 'date' }`). Every FK column has an index (cascade performance).
Text lengths are enforced in the DB too (defence in depth; Zod enforces the same limits).

The Drizzle files are the source of truth (`users.ts`, `collections.ts`, `vocabulary.ts`, `srs.ts`,
`practice.ts`, `enums.ts`); `0001_tables.sql` is generated from them. CHECK bounds are literals inside
each `sql` template: DDL can't take bound parameters, and `sql.raw` is lint-banned.

| Table                 | Key columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`               | `email` citext unique (3–254) · `password_hash` · `native_language` (format) · `daily_new_limit` 0–1000 (20) · `daily_review_limit` 0–10000 (200) · `timezone` (UTC). No `deleted_at` (D6).                                                                                                                                                                                                                                                                                                                          |
| `collections`         | `owner_id` → users · `title` 1–200 · `native_language` ≠ `target_language` (format) · `description` ≤ 2000 · `topic` · `normalization` jsonb object ≤ 4 KB · `archived_at`. Index `(owner_id, created_at desc)`.                                                                                                                                                                                                                                                                                                     |
| `vocabulary_entries`  | `collection_id` → collections · `target_expression`, **`normalized_target_expression`** (1–500, review L4), `native_expression` · `part_of_speech` · `topic` · `revision` ≥ 1. Indexes `(collection_id, created_at, id)` (keyset) and `(collection_id, normalized_target_expression)` (duplicate lookup on create/CSV import).                                                                                                                                                                                       |
| `vocabulary_meanings` | `entry_id` → entries · `definition` · `grammatical_metadata` jsonb object. `UNIQUE (id, entry_id)` is the target of the composite FKs below.                                                                                                                                                                                                                                                                                                                                                                         |
| `accepted_answers`    | `entry_id` · `meaning_id` (composite FK `(meaning_id, entry_id)`: a meaning of the same entry) · `language` (format; in the collection's pair, RC003) · `answer_text` · `normalized_text` 1–500 (never empty, rule 3) · `is_primary` (one per entry+language). **`UNIQUE (entry_id, language, normalized_text)`** (review L3; also serves the answer-engine lookup).                                                                                                                                                 |
| `vocabulary_synonyms` | **New (review).** `entry_id` · `meaning_id` (composite FK, US-MCQ-02 "attached to specific meanings") · `language` (format, RC003) · `text` · `normalized_text` · `approval_status` (pending) · `created_at`. `UNIQUE (entry_id, language, normalized_text)`. Only approved synonyms are used later.                                                                                                                                                                                                                 |
| `sentence_examples`   | **New (review, spec §14.1).** `entry_id` · `meaning_id` (composite FK) · `language` (format, RC003) · `sentence` 1–1000 · `translation` ≤ 1000 · `target_answer` 1–500 · **`slots` jsonb** · `approval_status` · `created_at`. See "slots" below.                                                                                                                                                                                                                                                                    |
| `answer_change_log`   | Append-only. `answer_id` (soft reference) · `entry_id` · `user_id` · `action` with matching `before`/`after` objects.                                                                                                                                                                                                                                                                                                                                                                                                |
| `answer_flags`        | `user_id` · `entry_id` · `direction` · `submitted_answer` 1–500 · `status`. **Unique open flag** `(user_id, entry_id, direction, submitted_answer) WHERE status = 'pending'` (review L3).                                                                                                                                                                                                                                                                                                                            |
| `srs_cards`           | Full ts-fsrs 6 / FSRS-7 card (D1). `UNIQUE (user_id, entry_id, direction)`. Finite/range CHECKs (`< 'Infinity'` also rejects NaN), `lapses ≤ reps`, **`scheduler_version` ~ `^ts-fsrs@x.y.z/fsrs-n$`**, **millisecond precision** on `due_at`/`last_review_at`. Index `(user_id, due_at)`.                                                                                                                                                                                                                           |
| `srs_review_logs`     | Append-only. `card_id` · **`user_id`** → users (= the card's user, RC001; review L1) · `client_review_id` · `rating` (again..easy) · `reviewed_at` (ms) · **`entry_revision`** ≥ 1 (≤ the entry's revision, RC004; review M2) · `previous_state`/`next_state` (snapshot format, §3.1) · `previous_due_at`, `next_due_at` · `scheduler_version` (format). **`UNIQUE (card_id, client_review_id)`** (review L4). Indexes `(card_id, reviewed_at)` and **`(user_id, reviewed_at)`** ("reviews today", new-card counts). |
| `practice_attempts`   | Append-only, no relation to `srs_*`. `user_id` · `entry_id` · `exercise_type` · `direction` · `source_mode` · `submitted_answer` · **`expected_answer`** (snapshot) · **`entry_revision`** (≤ the entry's, RC004) · `matched_answer_id` (SET NULL; a match implies correct) · `is_correct` · `diff` array · `session_id`.                                                                                                                                                                                            |

**Sentence slots (decision: one jsonb column, not a child table).** `slots` is an array of 1–10
`{ "start": int, "end": int, "answer": string }`: character offsets into `sentence` (end exclusive) and
the expected text, which must be non-blank. One CHECK (`sentence_examples_slots_format`, via the
immutable `jsonb_path_exists`) validates shape, integer offsets, `0 ≤ start < end ≤ char_length(sentence)`,
and size ≤ 4 KB. Slots are always read and written with their sentence, so a child table would only add
joins and grants. Overlap between slots is left to Zod (LEX for CTX, post-MVP).

**Delete behaviour (GDPR, architecture §8):** `users` → (collections, answer_change_log, answer_flags,
srs_cards, srs_review_logs, practice_attempts) CASCADE; `collections` → `vocabulary_entries` CASCADE; `vocabulary_entries` →
(meanings, accepted_answers, synonyms, sentence examples, answer_change_log, answer_flags, srs_cards,
practice_attempts) CASCADE; `vocabulary_meanings` → (accepted_answers, synonyms, sentence examples)
CASCADE (composite FKs); `srs_cards` → `srs_review_logs` CASCADE;
`accepted_answers` → `practice_attempts.matched_answer_id` SET NULL. **No FK action ever UPDATEs
`srs_cards`**, so editing content can't touch scheduling (US-VOC-02). `DELETE FROM users WHERE id = $1`
removes everything. Verified in the probe: FK cascade actions run as the **table owner**, so cascades
reach `srs_cards`/`srs_review_logs` even though the app role has no DELETE on them.

---

## 3. SRS guard (architecture §5, layer 3)

### 3.1 Design (D4 = variant B)

A scheduling change to `srs_cards` needs a **grant**, and a grant exists only because a
`srs_review_logs` row was inserted in the same transaction. Grants are rows in a private table,
`srs_guard.review_grants`, keyed by the top-level transaction id (`pg_current_xact_id()`, so
savepoints share it). Only `SECURITY DEFINER` trigger functions read or write that table. The app role
has no privilege on schema `srs_guard`, so it can't forge, read, replay, or clear a grant, and no
setting (`set_config`) has any effect on the guard.

1. `AFTER INSERT ON srs_review_logs` (definer) checks that the log's `user_id` is the card's user
   (`RC001`) and that `entry_revision` isn't ahead of the entry (`RC004`), then opens the grant
   `(log_id, card_id, xact_id)`. It refuses if this transaction already has an open grant (`SR003`).
2. `BEFORE UPDATE ON srs_cards` (definer): identity columns never change (`SR005`). If any of the 12
   scheduling columns changes, the transaction's grant must exist (`SR001`), and the update must be
   **exactly** the logged transition, otherwise `SR002` (security review M1):
   - `card_id = NEW.id`, `previous_due_at = OLD.due_at`, `next_due_at = NEW.due_at`,
     `scheduler_version = NEW.scheduler_version`;
   - `NEW.last_review_at = reviewed_at`, `reviewed_at ≥ OLD.last_review_at`, `NEW.due_at > reviewed_at`;
   - `NEW.reps = OLD.reps + 1`; `NEW.lapses` is `OLD.lapses` or `OLD.lapses + 1`, and `+1` only with `again`;
   - `previous_state` equals the card before and `next_state` the card after, for all 12 scheduling
     columns (`srs_guard.snapshot_matches`).

   The grant is then **deleted** (one log authorizes exactly one update) and `updated_at` is set.

   **Snapshot format** (`SRS_SNAPSHOT_KEYS` in `server/db/schema/srs.ts`): exactly the 12 scheduling
   columns as Drizzle camelCase keys (`state`, `scheduleStatus`, `dueAt`, `stability`, `stabilityFast`,
   `difficulty`, `scheduledDays`, `learningSteps`, `reps`, `lapses`, `lastReviewAt`, `schedulerVersion`);
   enum labels as strings, numbers as JSON numbers (so NaN/Infinity can't appear), timestamps as ISO 8601
   with milliseconds, `null` only for an absent `stabilityFast`/`lastReviewAt`. Missing or extra keys,
   wrong types, or any differing value → `SR002`. The LEX-007 mapper converts ts-fsrs cards to this
   shape (`learningStep` → `learningSteps`, numeric `state` → label). Because snapshots can't carry
   microseconds, SRS timestamps are stored with millisecond precision (CHECKs; the insert trigger
   truncates `due_at`).

3. `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `srs_review_logs` (definer): **at COMMIT**, a
   log whose grant still exists aborts the transaction (`SR004`). A log can't be stored without its card
   update, autocommit log inserts fail, and `SET CONSTRAINTS ALL IMMEDIATE` fails closed.
4. `BEFORE INSERT ON srs_cards` (invoker, no table access): inserts must be a **pristine new card**
   with `due_at ≤ now() + 5 minutes` (no silently suspended cards) (`SR006`); `due_at` is truncated to
   milliseconds and `updated_at := now()` (security review L1). Card creation can't write history (US-VOC-03). `ON CONFLICT DO NOTHING` works for idempotent
   creation; `ON CONFLICT DO UPDATE` of scheduling fields hits guard 2 and fails (`SR001`).
5. **DELETE** is not a trigger concern: the app role has no DELETE on `srs_cards` or `srs_review_logs`
   (§4). Cards and logs only disappear through entry, collection, or user cascades.
6. Grant rows never outlive their transaction: commit requires them consumed (3), rollback removes them.
   A grant opened in a rolled-back savepoint is rolled back with its log.

Every function pins `SET search_path = pg_catalog, pg_temp`, references objects schema-qualified, and has
`EXECUTE` revoked from `PUBLIC` (a trigger doesn't need `EXECUTE` to fire, verified by the tests).

Custom SQLSTATEs (class `SR`, unused by Postgres) let tests assert exact failures. The review service
maps them to a 500 response, because they always indicate a bug, never a user error.

| Code    | Meaning                                               |
| ------- | ----------------------------------------------------- |
| `SR001` | scheduling update without a pending review log        |
| `SR002` | update doesn't match the pending log                  |
| `SR003` | second review log inserted while one is still pending |
| `SR004` | review log committed without its card update          |
| `SR005` | card identity columns are immutable                   |
| `SR006` | card insert is not a pristine new card                |

Shared with the integrity triggers (§D7, `0003`): `RC001` owner mismatch · `RC002` collection languages
immutable once entries exist · `RC003` language outside the collection's pair · `RC004` `entry_revision`
ahead of the entry.

### 3.2 SQL

`server/db/migrations/0002_srs_guard.sql` (custom migration, statements separated with
`--> statement-breakpoint`) is the source of truth.

### 3.3 Review submission with the guard (LEX-009 contract)

```
BEGIN                                            -- top-level db.transaction()
  SELECT … FROM srs_cards WHERE id = $card AND user_id = $session FOR UPDATE
  SELECT … FROM srs_review_logs
    WHERE card_id = $card AND client_review_id = $crid                  -- replay lookup, per card (L4)
  INSERT INTO srs_review_logs (…)                -- opens grant
  UPDATE srs_cards SET …next                     -- consumes grant
COMMIT                                           -- deferred check passes
```

Rules for the service: insert the log **before** the card update, process one card per transaction, and
never use `SET CONSTRAINTS … IMMEDIATE`. Any other order fails closed.

### 3.4 Practice and other modes

Practice, test, and guided code can't reference the SRS tables (lint rule, D12). Even if it reached the
database, it could only open a grant by inserting a `srs_review_logs` row, and the deferred check would
then require the matching card update in the same transaction. A plain `UPDATE srs_cards` from any
other code path fails with `SR001`.

### 3.5 No reset path (D3 = b)

There is no reset endpoint, no reset function, and no `manual` rating. When a user changes an entry so
much that its meaning is materially different, the UI offers the "new entry" action (spec US-VOC-02): a
new entry gets new pristine cards, and the old entry's history stays intact. `POST /api/review/submit`
remains the only SRS write path, and CLAUDE.md rule 1 is unchanged.

### 3.6 Residual risk

Variant A's deliberate-bypass risk (clearing a transaction setting after inserting a log) does not exist
in variant B: the app role can't touch `srs_guard`. What remains is that the database can't verify FSRS
math: code in the SRS module can log and apply any transition that is consistent with its own log. That
is the intended trust boundary (layer 1: only `review.service.ts` writes, enforced by lint and review).

## 4. Least-privilege roles

### 4.1 Roles

| Role                | Attributes                                                                        | Purpose                                                   |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `recallio_migrator` | LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, **database owner**                  | Runs migrations; owns all tables, types, and functions    |
| `recallio_app`      | LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOINHERIT, not a member of any role | Runtime (Nitro) connection; DML only                      |
| `$POSTGRES_USER`    | Docker superuser                                                                  | Local bootstrap only; never used by the app or migrations |

Roles are **provisioned outside migrations**: by the Docker init script locally and by the hosting
provider in production (LEX-017). Migrations contain no passwords and no `CREATE ROLE`. They only
`GRANT` to `recallio_app` and **fail loudly if the role doesn't exist**.

### 4.2 Privilege matrix for `recallio_app` (custom migration `0004_app_role_grants.sql`)

UPDATE is **column-level everywhere** (security review H1): keys, owner and parent columns (`id`,
`owner_id`, `collection_id`, `entry_id`, `user_id`, `card_id`) and `created_at` are never updatable, so a
row can't be moved to another user or parent after the insert-time checks ran (this also closes the
"move the entry to bypass RC002" gap).

| Table                                 | Table-level            | UPDATE columns                                                                                                  |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| users                                 | SELECT, INSERT, DELETE | email, password_hash, native_language, daily_new_limit, daily_review_limit, timezone                            |
| collections                           | SELECT, INSERT, DELETE | title, native_language, target_language, description, topic, normalization, archived_at                         |
| vocabulary_entries                    | SELECT, INSERT, DELETE | target_expression, normalized_target_expression, native_expression, part_of_speech, topic, revision, updated_at |
| vocabulary_meanings                   | SELECT, INSERT, DELETE | definition, grammatical_metadata                                                                                |
| accepted_answers                      | SELECT, INSERT, DELETE | meaning_id, language, answer_text, normalized_text, is_primary                                                  |
| answer_flags                          | SELECT, INSERT, DELETE | status                                                                                                          |
| vocabulary_synonyms                   | SELECT, INSERT, DELETE | meaning_id, language, text, normalized_text, approval_status                                                    |
| sentence_examples                     | SELECT, INSERT, DELETE | meaning_id, language, sentence, translation, target_answer, slots, approval_status                              |
| answer_change_log                     | SELECT, INSERT         | none (append-only)                                                                                              |
| practice_attempts                     | SELECT, INSERT         | none (append-only)                                                                                              |
| srs_review_logs                       | SELECT, INSERT         | none (append-only)                                                                                              |
| srs_cards                             | SELECT, INSERT         | the 12 scheduling columns; no DELETE                                                                            |
| `drizzle.*`, `srs_guard.*`, functions | none                   |                                                                                                                 |

No TRUNCATE, REFERENCES, or TRIGGER privileges anywhere. No CREATE on any schema. No ownership of
anything. `SELECT … FOR UPDATE/SHARE` works because the role has UPDATE on at least one column of each
locked table. `meaning_id` stays updatable: the composite FK keeps it on the same entry.

**Deviation from review L1 (column-level INSERT on `srs_cards`): not applied.** Drizzle's `insert()`
lists every column of the table and sends `DEFAULT` for unset ones, and Postgres checks column INSERT
privilege even for `DEFAULT` (verified). A column-level INSERT grant would make every Drizzle card insert
fail with 42501, including the reviewers' `fsrs-roundtrip` test. INSERT stays table-level; the insert
trigger enforces the same guarantee (pristine values, `due_at` bound, forced `updated_at`), and the
format CHECK pins `scheduler_version`. If column-level INSERT is still wanted, card creation (LEX-005)
must use a `sql` template instead of `db.insert(srsCards)`: a decision for Alina.

The exact grant statements are in `server/db/migrations/0004_app_role_grants.sql`.

No `ALTER DEFAULT PRIVILEGES`: every new table needs an explicit grant in its own migration. The
privilege-matrix test (§5.4) fails on any table missing from the matrix.

### 4.3 Local setup

- `docker/postgres/initdb/10-roles.sh` is mounted read-only at `/docker-entrypoint-initdb.d/`. It runs only on an
  empty volume and does the following. It uses `psql -v ON_ERROR_STOP=1` and reads passwords inside psql
  with `\getenv`, bound as psql variables (`:'app_pw'`): never interpolated by the shell, never on a command line.
  1. Creates both roles with passwords from `RECALLIO_MIGRATOR_PASSWORD` / `RECALLIO_APP_PASSWORD`.
  2. Runs `ALTER DATABASE "$POSTGRES_DB" OWNER TO recallio_migrator` and `CREATE DATABASE recallio_test OWNER recallio_migrator`.
  3. On each DB: `REVOKE ALL ON DATABASE … FROM PUBLIC; GRANT CONNECT … TO recallio_app` (this also removes TEMP).
- Since PG15, `public` is owned by `pg_database_owner`, so the migrator owns it and can create
  `citext`, a trusted extension (migration `0000`).
- `compose.yaml`: add the volume mount, plus `RECALLIO_MIGRATOR_PASSWORD: ${RECALLIO_MIGRATOR_PASSWORD:?set in .env}` and the app equivalent.
  The healthcheck uses TCP (`pg_isready -h 127.0.0.1`), so `docker compose up --wait` returns only after the init script finished.
- **Existing local volumes must be recreated** (`pnpm db:reset` = `docker compose down -v && pnpm db:up && pnpm db:migrate`).
  The LEX-001 volume ran `0000` as the superuser, so the migrator can't write its migrations table.

### 4.4 Env and config

```dotenv
# .env.example
POSTGRES_USER=postgres                       # docker bootstrap superuser, local only
POSTGRES_PASSWORD=change-me-locally
POSTGRES_DB=recallio
POSTGRES_PORT=5432
RECALLIO_MIGRATOR_PASSWORD=change-me-locally-migrator
RECALLIO_APP_PASSWORD=change-me-locally-app
NUXT_DATABASE_URL=postgres://recallio_app:change-me-locally-app@localhost:5432/recallio                 # runtime
DATABASE_MIGRATOR_URL=postgres://recallio_migrator:change-me-locally-migrator@localhost:5432/recallio   # drizzle-kit only
TEST_DATABASE_URL=postgres://recallio_app:change-me-locally-app@localhost:5432/recallio_test
TEST_DATABASE_MIGRATOR_URL=postgres://recallio_migrator:change-me-locally-migrator@localhost:5432/recallio_test
```

- **Runtime** keeps reading only `runtimeConfig.databaseUrl` (`NUXT_DATABASE_URL`, now the app role).
  `DATABASE_MIGRATOR_URL` has no `NUXT_` prefix and is never referenced in `nuxt.config.ts`, so it can't
  reach the server bundle or runtime config.
- **`server/utils/env.ts`:** extract the URL and TLS rule into an exported `databaseUrlSchema`/`checkDatabaseUrl(url, { requireTlsIfRemote })`.
  Add `validateMigrationConfig({ migratorUrl })`, which always applies the `verify-full` rule to
  non-loopback hosts (migrations against a remote DB must verify TLS, whether or not a server is built).
  Messages still never echo values.
- **`drizzle.config.ts`:** read `DATABASE_MIGRATOR_URL` through `validateMigrationConfig` (relative
  import; the file only depends on zod). It loads `.env` when present (never overriding set variables).
  `generate`/`check` don't need a database URL, so the drift check runs without one.
- **Boot privilege check (D9):** `server/utils/db-privileges.ts` (`findDbRoleProblems`) checks, for the
  current role and every role it can `SET ROLE` to: superuser, CREATEROLE/CREATEDB, BYPASSRLS,
  REPLICATION, membership in `pg_write_all_data` or `pg_execute_server_program` / `pg_read_server_files` /
  `pg_write_server_files`, `SET` on `session_replication_role`, CREATE or TEMP on the database, CREATE on
  any schema, ownership of the database, a schema, a relation, or a function, TRUNCATE/TRIGGER on any
  table, USAGE on `srs_guard`, UPDATE/DELETE on `srs_review_logs`, and DELETE on `srs_cards` (review L3).
  Object lookups use `to_regnamespace`/`to_regclass`, so a missing object reads as "no privilege"
  instead of throwing. The file is the one reviewed exception to the SRS lint rule (it names the SRS
  objects in catalog queries only).
  - `server/plugins/02.db-privileges.ts` runs the check at boot. A **built** server with any problem logs
    the problem descriptions (fixed strings, never values) and exits with code 1. The dev server only warns.
  - `server/middleware/00.db-role.ts` keeps a built server **closed** (503) until the check has passed,
    which covers a database that is unreachable at boot; the check is retried on the next request.
    `/api/health` is exempt so it can still report `degraded`. (A middleware is needed: Nitro ignores
    errors thrown from `request` hooks.)

---

## 5. Migration strategy

| File                          | How                                              | Content                                                       |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `0000_init.sql`               | exists                                           | `citext`                                                      |
| `0001_<generated>.sql`        | `pnpm db:generate`                               | enums, tables, FKs, CHECKs, indexes (from `server/db/schema`) |
| `0002_srs_guard.sql`          | `drizzle-kit generate --custom --name srs_guard` | §3.2                                                          |
| `0003_integrity_triggers.sql` | custom (only if D7 is approved)                  | owner-consistency + collection-language immutability          |
| `0004_app_role_grants.sql`    | custom                                           | §4.2 (last, so it covers every table)                         |

- Custom files are registered in `meta/_journal.json` by drizzle-kit and are invisible to the snapshot,
  so later `generate` runs never try to drop triggers or grants. Separate each statement, and keep each
  `CREATE FUNCTION` body whole, with `--> statement-breakpoint`.
- The drizzle migrator applies all pending migrations in **one transaction**. Consequence: a future
  `ALTER TYPE … ADD VALUE` can't be _used_ by a later migration in the same batch. Put the use in the next release.
- Merged migrations are never edited (architecture §8 A08). Changes ship as new migrations.
- **Drift check** (CI, LEX-017): `pnpm db:generate` must produce no new files (`git diff --exit-code server/db/migrations`).
- `package.json` scripts: `db:migrate` stays on drizzle-kit (uses `DATABASE_MIGRATOR_URL`). Add
  `db:reset` and `test:integration`. `test` runs only the `unit`, `security`, and `nuxt` projects, so it
  (and `pnpm check`) works without Docker.

---

## 6. Test plan

### 6.1 Unit (`tests/unit`, no DB)

| #   | Case                                                                                                                                                                                                                                                                               | Covers               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| U1  | `SRS_STATES[i]` ↔ ts-fsrs `State` numeric values; `SRS_RATINGS[i]` ↔ `Rating` i+1 (Again=1 … Easy=4)                                                                                                                                                                               | US-SRS-01            |
| U2  | **Lossless mapping:** for `DefaultScheduler()` (FSRS-7) and `{ version: 'FSRS-6' }`, every key of `newCard()` and `review().card` is in `FSRS_CARD_FIELD_MAP`, and every mapped value is a column of `srsCards` (`getTableColumns`). Fails on a ts-fsrs upgrade that adds a field. | US-SRS-01, §14.1     |
| U3  | `languageCodeSchema` accepts `fr`, `en`; rejects `de`, `FR`, `fra`, `''`                                                                                                                                                                                                           | DEC-001, decision #3 |
| U4  | `validateMigrationConfig`: loopback OK without TLS; remote requires exactly one `sslmode=verify-full`; errors never contain the URL                                                                                                                                                | §8 A02/A04           |
| U5  | `reviewRatingSchema` rejects `manual`                                                                                                                                                                                                                                              | US-SRS-01            |

### 6.2 Integration project setup

- New Vitest project `integration`: `include: ['tests/integration/**/*.test.ts']`, `environment: 'node'`,
  `globalSetup: 'tests/integration/global-setup.ts'`, files run serially (`fileParallelism: false`, or
  the Vitest 5 per-project equivalent; the tester verifies this).
- **global-setup** (migrator URL):
  1. Refuse to run unless both test URLs point at a database whose name ends in `_test`.
  2. `DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
  3. `migrate()` from `drizzle-orm/postgres-js/migrator`.

  Every run therefore proves the issue's criterion that migrations apply on an empty DB.

- **Helpers** (`tests/integration/helpers/`):
  - `asApp()` / `asMigrator()`: postgres.js clients for the two roles.
  - `factories.ts`: `createUser`, `createCollection`, `createEntry` (with meaning, answers, and 2 pristine cards), `reviewCard(tx, card, next)`, which mimics the §3.3 order.
  - `expectPgError(p, { code, constraint? })`: asserts on SQLSTATE and constraint name, never on message text.
- **Isolation:** `beforeEach` runs `TRUNCATE` on all `public` tables `CASCADE` (as migrator). Tests
  commit for real, because the deferred trigger only fires at COMMIT, so rollback-per-test can't be used.
- **One run at a time (review M3):** the global setup takes `pg_try_advisory_lock` on its own migrator
  session for the whole run and fails fast with a clear message if another run holds it. Concurrency
  tests wait with `waitForLockWait()` (polls `pg_stat_activity` for a lock wait) instead of timers, and
  always release the held transaction in `finally`.
- Requires `pnpm db:up`. CI uses a Postgres 17 service container and the same init script (LEX-017).

### 6.3 Constraints (`schema.constraints.test.ts`, as **app** role)

| #   | Case                                                                                                                                               | Expect                                     | Covers            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------- |
| C1  | second card same (user, entry, direction) → error; other direction → OK                                                                            | 23505 `srs_cards_user_entry_direction_key` | §14.2, US-SRS-02  |
| C2  | two logs with same `client_review_id` (sequential, and concurrent on two connections)                                                              | 23505                                      | US-SRS-03         |
| C3  | collection with `native_language = target_language`                                                                                                | 23514 `collections_languages_differ`       | US-VOC-01         |
| C4  | language `EN`, `fra`, `''` on users/collections/accepted_answers                                                                                   | 23514 `*_code`                             | DEC-001           |
| C4b | language `de`: DB accepts (format only), `languageCodeSchema` rejects (U3). If D5 = alternative, DB rejects with 23514                             | —                                          | decision #3       |
| C5  | `users.email` `A@x.fr` vs `a@x.fr`                                                                                                                 | 23505 (citext)                             | US-AUTH-01        |
| C6  | accepted answer whose `meaning_id` belongs to another entry                                                                                        | 23503 `accepted_answers_meaning_entry_fk`  | US-VOC-04         |
| C7  | two primary answers for same (entry, language)                                                                                                     | 23505                                      | US-VOC-04         |
| C8  | `normalized_text = ''`                                                                                                                             | 23514                                      | rule 3, US-TYP-03 |
| C9  | `stability` = `NaN`, `Infinity`, `-1`; `difficulty = 11`; `lapses > reps` (inserted as migrator with trigger-valid flow, or via a reviewed update) | 23514                                      | §14.2             |
| C10 | log with `next_due_at < reviewed_at`                                                                                                               | 23514                                      | §14.2             |
| C11 | attempt with `matched_answer_id` set and `is_correct = false`                                                                                      | 23514                                      | rule 3            |
| C12 | `answer_change_log` action/before/after mismatches (each of 3 actions)                                                                             | 23514                                      | US-VOC-04         |
| C13 | `daily_new_limit = -1` / `1001`; `daily_review_limit = 10001`                                                                                      | 23514                                      | US-SRS-04         |
| C14 | non-object `normalization`, `grammatical_metadata`, `previous_state`; non-array `diff`                                                             | 23514                                      | —                 |
| C15 | unknown enum value (`direction = 'both'`, `rating = 'perfect'`)                                                                                    | 22P02                                      | —                 |
| C16 | (D7) changing collection languages after an entry exists                                                                                           | `RC002`                                    | DEC-001, §14.2    |
| C17 | (D7) card/attempt/flag for user B on user A's entry                                                                                                | `RC001`                                    | rule 5            |

### 6.4 SRS guard (`srs-guard.test.ts`, as **app** role)

| #   | Case                                                                                                               | Expect          |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------- |
| G1  | UPDATE any scheduling column without a log (each of the 12 columns, parameterized)                                 | `SR001`         |
| G2  | Review tx: insert log + matching update → commit; card has new values; `updated_at` advanced                       | OK              |
| G3  | Insert log, no card update, COMMIT → fails; log row not persisted                                                  | `SR004`         |
| G4  | Autocommit log insert                                                                                              | `SR004`         |
| G5  | Log for card A, update card B                                                                                      | `SR002`         |
| G6  | Update whose `due_at` / `scheduler_version` differs from the log, or whose OLD `due_at` ≠ `previous_due_at`        | `SR002`         |
| G7  | One log, two updates in the same tx → second fails                                                                 | `SR001`         |
| G8  | Two log inserts before any update                                                                                  | `SR003`         |
| G9  | Pristine card INSERT → OK; INSERT with `reps=1` / `state='review'` / `last_review_at` set / `stability=1`          | `SR006`         |
| G10 | `INSERT … ON CONFLICT DO NOTHING` duplicate → OK, card unchanged; `ON CONFLICT DO UPDATE SET due_at`               | `SR001`         |
| G11 | Rating `manual` is not a valid `srs_rating` (D2 rejected)                                                          | 22P02           |
| G12 | Review inside a released savepoint → OK. Log-only insert in a rolled-back savepoint, then COMMIT → OK, no log      | OK              |
| G13 | App UPDATE of `user_id`/`entry_id`/`direction` → 42501. Same as migrator → `SR005`                                 | 42501 / `SR005` |
| G14 | No-op update (same values) → OK, no grant needed                                                                   | OK              |
| G15 | App can't INSERT/SELECT/DELETE `srs_guard.review_grants` or call the trigger functions; `set_config` has no effect | 42501 / `SR001` |
| G16 | App: `SET session_replication_role = replica` / `ALTER TABLE srs_cards DISABLE TRIGGER …`                          | 42501           |

### 6.5 Roles (`roles.test.ts`)

| #   | Case                                                                                                                                                               | Expect |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| R1  | App: `CREATE TABLE`, `CREATE TEMP TABLE`, `CREATE FUNCTION`, `CREATE SCHEMA`, `DROP TABLE users`, `ALTER TABLE users ADD COLUMN x int`, `CREATE INDEX`             | 42501  |
| R2  | App: `TRUNCATE` on **every** table in `public` (parameterized from the catalog)                                                                                    | 42501  |
| R3  | App: `DELETE FROM srs_cards`, `UPDATE/DELETE srs_review_logs`, `UPDATE/DELETE practice_attempts`, `UPDATE/DELETE answer_change_log`                                | 42501  |
| R4  | **Privilege matrix:** `has_table_privilege` / `has_column_privilege` for every table and privilege equals §4.2 exactly. Any catalog table not in the matrix fails. | equal  |
| R5  | App role attributes: not superuser / createrole / createdb / bypassrls; owns no objects; not a member of `recallio_migrator`; `SET ROLE recallio_migrator` fails   | —      |
| R6  | App can't read `drizzle.__drizzle_migrations`                                                                                                                      | 42501  |
| R7  | (D9) the boot privilege check returns "unsafe" for the migrator URL and "safe" for the app URL                                                                     | —      |

### 6.6 Cascades (`cascade.test.ts`, deletes run as **app** role)

| #   | Case                                                                                                                                                                                                              | Covers        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| X1  | Seed one user with **at least one row in every `public` table** (the test fails if any catalog table is left unseeded). Then `DELETE FROM users` → every table has 0 rows, and a second user's data is untouched. | GDPR §8, §15  |
| X2  | Delete collection → its entries, meanings, answers, change log, flags, cards, review logs, and attempts are gone; other collection intact                                                                         | US-VOC-01     |
| X3  | Delete entry as app → cards + logs gone (app has no DELETE on srs tables; cascade runs as owner)                                                                                                                  | §4.2          |
| X4  | Delete accepted answer → attempt kept with `matched_answer_id = null`; change log kept                                                                                                                            | §14.2 history |
| X5  | Delete meaning → its accepted answers gone, entry intact                                                                                                                                                          | US-VOC-04     |
| X6  | Updating an entry (text, `revision + 1`) leaves both cards byte-identical                                                                                                                                         | US-VOC-02     |

### 6.7 Migrations (`migrations.test.ts`)

- M1: after global setup, the catalog lists the expected tables, enums (with value order), triggers
  (only the log check deferred), and functions (search_path pinned, no EXECUTE for the app role).
- M2: running `migrate()` a second time is a no-op. M3: the run lock is held.
- Drift: `pnpm db:generate` reports no changes; `schema-parity.test.ts` compares the Drizzle schema with
  the migrated catalog (columns, types, nullability, constraints, indexes).

### 6.8 Added by the security and tester reviews

| File                         | Covers                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `srs-guard.security.test.ts` | No SET ROLE / replication role / catalog shadowing; stale concurrent review → SR002; exact-match rules; insert pins |
| `ownership.security.test.ts` | Owner/parent columns not updatable (H1); RC002 race: entry insert waits for a language change (L2)                  |
| `integrity-gaps.test.ts`     | Moving an entry can't bypass RC002; answer language in the collection pair                                          |
| `fsrs-roundtrip.test.ts`     | Real ts-fsrs 6 cards (FSRS-7 and FSRS-6) through the guarded path with Drizzle: lossless card and snapshots         |
| `schema-parity.test.ts`      | Drizzle schema = migrated catalog                                                                                   |
| `srs-separation.test.ts`     | Every practice mode × type × direction and every content write leaves `srs_*` byte-identical (rule 1)               |
| `review-concurrency.test.ts` | Same-card replay waits on the row lock then 23505; two submissions serialize                                        |
| `query-indexes.test.ts`      | The planned query shapes can use their indexes                                                                      |
| `content-tables.test.ts`     | Synonyms and examples (composite FK, RC003, grants, cascade, slot format); answer/flag duplicates                   |
| `review-history.test.ts`     | Log owner (RC001), entry revision (RC004), previous_state / lapse / date rules, ms-precision inserts                |

## 7. Decisions (final outcome in the last column)

D1 and D5–D10 were approved as recommended. D2 was rejected, D3 = (b), D4 = B.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                             | Outcome                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| D1  | **Schema additions/removals for ts-fsrs 6 (FSRS-7) losslessness:** add `srs_cards.stability_fast` (nullable double) and `srs_cards.schedule_status` (enum new/learning/review). Drop `srs_cards.elapsed_days` (gone in ts-fsrs 6; derivable from `last_review_at`). Store `scheduled_days` as double (fractional in FSRS-7). Target the non-deprecated `DefaultScheduler` API, FSRS-7, `scheduler_version = 'ts-fsrs@6.0.0/fsrs-7'`. | **Approved.** Required by US-SRS-01 ("persists … memory state"); without `stability_fast`, FSRS-7 state is lost. |
| D2  | Add `manual` to the `srs_rating` enum (ts-fsrs `Rating.Manual`) for reset logs.                                                                                                                                                                                                                                                                                                                                                      | **Rejected.** There is no reset path (D3), so no `manual` rating is stored.                                      |
| D3  | **Reset endpoint.** CLAUDE.md rule 1 says SRS writes happen "only through `POST /api/review/submit`". A reset (US-VOC-02) needs a second entry point into `review.service.ts`. Options: (a) add `POST /api/review/reset` in the srs module and amend rule 1 and architecture §5 layer 2 to name both routes; (b) MVP offers only the "new-entry action" the spec also allows, and reset is deferred. The DB design supports both.    | **Decided: (b).** No reset endpoint; a materially different meaning is a new entry. Rule 1 unchanged.            |
| D4  | **Guard variant.** A: transaction-local `app.review_id` set by DB triggers (§3, matches approved architecture; residual deliberate-bypass risk §3.6). B: same flow, but the grant is a row in a private `srs_review_grants` table written by `SECURITY DEFINER` functions the app role can't touch. B closes §3.6 at the cost of one internal table and definer functions with a pinned `search_path`.                               | **Decided: B** (§3). The app role can't write the grants table or forge a grant.                                 |
| D5  | **Language allow-list in the DB:** format-only CHECK `^[a-z]{2}$` plus a Zod allow-list (adding a language stays a code-only change, as architecture §4 promises), vs `CHECK IN ('fr','en')` (stricter; each new language needs a one-line migration).                                                                                                                                                                               | **Approved: format CHECK + Zod.**                                                                                |
| D6  | **Drop `users.deleted_at`.** Account deletion is a hard delete (architecture §8), so the column would be dead and invites accidental soft-delete retention.                                                                                                                                                                                                                                                                          | **Approved: dropped.**                                                                                           |
| D7  | **Extra integrity triggers (`0003`):** (a) BEFORE INSERT on `srs_cards`, `practice_attempts`, `answer_flags`, `answer_change_log` checks that `user_id` owns the entry's collection (`RC001`; rule 5 defence in depth). (b) collection `native_language`/`target_language` immutable once entries exist (`RC002`; DEC-001, spec §14.2).                                                                                              | **Approved (both).** Both are cheap, and each enforces a stated rule.                                            |
| D8  | **Role model:** `recallio_migrator` (DB owner) + `recallio_app` (DML only), provisioned outside migrations; migrations only GRANT; separate `recallio_test` DB in the same container; existing local volumes must be reset once.                                                                                                                                                                                                     | **Approved.**                                                                                                    |
| D9  | **Boot-time privilege check** (built server refuses to start if the runtime role can do DDL, is superuser, or owns tables).                                                                                                                                                                                                                                                                                                          | **Approved.** It turns a misconfigured `NUXT_DATABASE_URL` into a startup failure.                               |
| D10 | **`pnpm test` excludes the integration project;** `pnpm test:integration` needs `pnpm db:up`. CI runs both.                                                                                                                                                                                                                                                                                                                          | **Approved.**                                                                                                    |

**Small decisions made (FYI, no approval needed):**

- PKs use `gen_random_uuid()`.
- Review additions decided by the backend: the guard also checks `previous_state` against the card
  before the update and requires `NEW.due_at > reviewed_at` and "lapse only on again"; SRS timestamps
  have millisecond precision (CHECKs); `answer_flags` "open" means `status = 'pending'`; RC004 bounds
  `entry_revision` by the entry's current revision (not equality, since a user may answer a prompt
  rendered from the previous revision); `accepted_answers_entry_language_idx` was dropped (the new
  unique index has the same prefix).
- Text and range limits as in §2.3 (Zod mirrors them).
- `normalization` and `grammatical_metadata` default to `'{}'`.
- `practice_attempts.matched_answer_id` uses ON DELETE SET NULL; `answer_change_log.answer_id` is a soft reference.
- `approval_status` is used by `answer_flags` now and by `sentence_examples` in R2.
- Exercise and source-mode enums hold MVP values only.
- Column name `learning_steps` is kept (maps to `learningStep`).
- **D12:** the layer-1 lint rule is added now (`eslint.config.mjs`, `srsBoundary`). Outside
  `server/services/srs/**`, `server/db/**`, and `tests/**` it bans importing `server/db/schema/srs`, importing
  `srsCards`/`srsReviewLogs` from the schema index (including namespace imports), member access
  `.srsCards`/`.srsReviewLogs` (e.g. `db.query.srsCards`), and string/template literals naming `srs_cards`,
  `srs_review_logs`, `srs_guard`, `set_config`, or `session_replication_role`.
- `srs_cards.updated_at` is not in the app role's column grant: the guard sets it.
- `answer_flags_check_entry_owner` (D7a) also fires on UPDATE of `user_id`/`entry_id`, since the app role can update flags.

---

## 7a. Review fixes (security and tester reviews, applied in place before merge)

| Finding     | Fix                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security H1 | Column-level UPDATE everywhere; owner/parent/key columns never updatable (§4.2). Also closes tester M1 (moving an entry bypassed RC002).                      |
| Security M1 | Exact log ↔ update match, documented camelCase snapshot format (§3.1).                                                                                        |
| Security L1 | Insert trigger: `due_at ≤ now() + 5 min`, ms truncation, `updated_at := now()`; `scheduler_version` format CHECK. Column-level INSERT **not applied** (§4.2). |
| Security L2 | `vocabulary_entries_lock_collection` (BEFORE INSERT, `FOR SHARE` on the collection) serializes entry inserts with language changes.                           |
| Security L3 | Boot check extended (§4.4).                                                                                                                                   |
| Security L4 | `UNIQUE (card_id, client_review_id)`; replay lookup per card.                                                                                                 |
| Tester M2   | `entry_revision` on `srs_review_logs` and `practice_attempts` (≤ entry revision, RC004); `practice_attempts.expected_answer`.                                 |
| Tester L1   | `srs_review_logs.user_id` (FK cascade, = card user, RC001) and index `(user_id, reviewed_at)`.                                                                |
| Tester L2   | RC003: answer/synonym/example language must be one of the collection's two languages.                                                                         |
| Tester L3   | `UNIQUE (entry_id, language, normalized_text)` on answers and synonyms; unique open flag.                                                                     |
| Tester L4   | `vocabulary_entries.normalized_target_expression` + index `(collection_id, normalized_target_expression)`.                                                    |
| Tester M3   | Advisory run lock; `waitForLockWait()` instead of timers.                                                                                                     |
| New scope   | `vocabulary_synonyms` and `sentence_examples` (slots as jsonb, §2.3).                                                                                         |

## 8. Files and owners

| File                                                                                                                                                                                   | Action              | Owner                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| `shared/constants/languages.ts`, `shared/constants/enums.ts`                                                                                                                           | create              | backend                                      |
| `shared/schemas/common.ts`                                                                                                                                                             | create              | backend                                      |
| `server/db/schema/{_shared,enums,users,collections,vocabulary,srs,practice}.ts`                                                                                                        | create              | backend                                      |
| `server/db/schema/index.ts`                                                                                                                                                            | modify (re-exports) | backend                                      |
| `server/db/migrations/0001_*.sql` + `meta/*` (generated)                                                                                                                               | create              | backend                                      |
| `server/db/migrations/0002_srs_guard.sql`, `0003_integrity_triggers.sql` (D7), `0004_app_role_grants.sql`                                                                              | create (custom)     | backend                                      |
| `server/utils/env.ts`                                                                                                                                                                  | modify              | backend                                      |
| `server/utils/db-privileges.ts` (lint exception), `server/db/role-gate.ts`, `server/plugins/02.db-privileges.ts`, `server/middleware/00.db-role.ts` (D9)                               | create              | backend                                      |
| `drizzle.config.ts`, `compose.yaml`, `docker/postgres/initdb/10-roles.sh`, `.env.example`, `package.json` (scripts), `eslint.config.mjs` (D12)                                         | modify/create       | backend                                      |
| `vitest.config.ts` (integration project), `tests/integration/**`, `tests/unit/{fsrs-mapping,enums,languages}.test.ts`, `tests/unit/env.test.ts`, `tests/security/env.security.test.ts` | create/modify       | tester                                       |
| `docs/architecture.md` §4/§5/§8, README, CLAUDE.md "Commands"                                                                                                                          | modify              | docs (CLAUDE.md rule text only by Alina, D3) |
| `app/**`                                                                                                                                                                               | none                | frontend: no work                            |

The uncommitted `ts-fsrs` addition in `package.json`/`pnpm-lock.yaml` belongs on this branch
(`build(deps): pin ts-fsrs 6.0.0`).

---

## 9. Risks and invariants

1. **SRS isolation.** Layers 1, 3, and 4 now exist at the DB level: the trigger, private grants, column
   grants, no DELETE, and append-only logs. Residual risk: §3.6 (the DB can't verify FSRS math).
2. **Idempotency across users.** `client_review_id` is unique **per card** (L4), so one user's id can't
   block or reveal another user's review. The service still loads the card owner-scoped first
   (`user_id = session user`, 404 otherwise) before the per-card replay lookup. IDOR test in LEX-009.
3. **Atomicity depends on order.** Log first, then card, one card per transaction, no `SET CONSTRAINTS
IMMEDIATE`. Any other order fails closed (`SR001`/`SR004`), so the only risk is availability, never integrity.
4. **Float hazards.** `NaN` passes `>= 0` checks in Postgres. All float checks use `< 'Infinity'`, and
   the JSON snapshot can't carry NaN/Infinity, so the guard rejects them first. The mapper (LEX-007)
   must also reject non-finite numbers before the write.
   4a. **Snapshot exactness.** The review service must build `previous_state` from the locked row and
   `next_state` from exactly the values it writes, with JS (millisecond) timestamps. Using `now()` in
   SQL for `reviewed_at` would fail closed (`SR002`/CHECK).
5. **ts-fsrs drift.** A version bump can add card fields or change semantics (FSRS-7 already did). U2
   fails on new fields. `scheduler_version` is stored on every card and log, and `ts-fsrs` stays pinned.
6. **Empty normalized answers** would match empty submissions. The DB check forbids them, and the
   service must reject answers that normalize to empty with a validation error.
7. **Enum evolution.** `ALTER TYPE … ADD VALUE` plus a same-batch use fails in the single-transaction
   migrator. Plan R2 enum additions as separate releases.
8. **Local migration.** Developers must recreate the Docker volume once (D8). The README and PR must say so.
9. **Ownership.** `vocabulary_entries` has no `user_id`. Ownership goes through `collections.owner_id`.
   D7(a) catches mismatched `user_id` on user-scoped child rows at insert time, and column grants keep
   owner/parent columns immutable afterwards. Services must still scope every query (rule 5).
   9a. **Language consistency.** Collection languages are immutable once entries exist (RC002, with the
   `FOR SHARE` lock closing the insert race), and answers/synonyms/examples must use one of the pair
   (RC003). Entries can't move between collections.
10. **History integrity.** Logs and attempts are append-only for the app role. Content edits never
    cascade into them. Deleting an answer only nulls `matched_answer_id`.
11. **Cascade-as-owner** is Postgres behaviour this design depends on. X1/X3 lock it in.
12. **Accessibility:** not affected (no UI).
13. **Secrets:** passwords live only in `.env`/provider secrets. The init script passes them as psql
    variables. The env validator never prints URLs. `DATABASE_MIGRATOR_URL` never reaches runtime config.

---

## 10. Consequences

- Positive: scheduling integrity, atomicity, and idempotency are enforced by Postgres, not only by code.
  The runtime credential can't change the schema. GDPR deletion is a single statement and is covered by
  an exhaustive test.
- Negative: more moving parts (2 roles, 6 trigger functions, a private grants table, custom migrations, a test DB). Every new
  table needs an explicit grant and a factory (the tests enforce this). Developers must reset their local volume once.
- Follow-ups: LEX-007 (mapper using `FSRS_CARD_FIELD_MAP`), LEX-009 (submission per §3.3 + IDOR test),
  LEX-005 (card creation; no reset, D3 = b), LEX-017 (prod role provisioning, CI Postgres service, drift check).
