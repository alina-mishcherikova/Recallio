# 0003 — Language-pair collections API and UI (LEX-004)

**Status:** Accepted (D1 = a, D2 = a, D3 = a; approved by Alina 2026-11-09) · **Date:** 2026-11-09 · **Issue:** #5 (LEX-004) ·
**Branch:** `feat/lex-004-collections-api` · **Depends on:** ADR 0001 (table, RC002, grants), ADR 0002
(`requireAuth`, `requireOwner`, error handler, Origin/JSON checks, `expectIdor`)

## 1. Context and scope

The `collections` table, its CHECKs, the RC002 language lock, and the app-role grants already exist
(ADR 0001). This issue adds the HTTP contract, the service, and a minimal UI. **No DB migration is
needed**: the app role already has `SELECT, INSERT, DELETE` and `UPDATE (title, native_language,
target_language, description, topic, normalization, archived_at)`, and the
`(owner_id, created_at desc)` index serves the owner-scoped keyset list.

| Story / AC                                                  | Covered by                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| US-VOC-01 "associated with that user"                       | `owner_id` = the session user on insert; never taken from input      |
| US-VOC-01 "requires a title, native and target language"    | `createCollectionSchema` (all three required)                        |
| US-VOC-01 "both languages must be different"                | Zod refine + DB CHECK `collections_languages_differ` (→ 400)         |
| US-VOC-01 "may have a description and topic"                | Optional, nullable fields                                            |
| US-VOC-01 "rename and archive"                              | `PATCH`, `POST …/archive`, `POST …/unarchive`                        |
| US-VOC-01 "destructive deletion requires confirmation"      | `DELETE` with `confirmTitle` (D1) + confirmation dialog              |
| DEC-001 "language configuration saved at collection level"  | Languages are stored per collection; defaults are client-side only   |
| DEC-001 / spec §14.2 languages immutable once entries exist | RC002 trigger → fixed 409                                            |
| Issue AC "ownership enforced (404 for others)"              | Owner-scoped queries + `requireOwner()`, `expectIdor` on every route |
| US-UI-01, US-UI-02                                          | Pages below; axe on desktop and mobile                               |

Out of scope: entries (LEX-005), normalization settings (LEX-010), due counts (LEX-007/014), full app
shell (LEX-015).

## 2. Contracts (`shared/schemas/collections.ts`, backend-owned, written first)

All objects are `.strict()`. `z` comes from `#shared/zod` (relative path in `shared/`).

### 2.1 Field rules

Lengths match the DB CHECKs, which use `char_length` (code points). Zod's `.max()` counts UTF-16 units,
so each text field uses a shared `boundedText(min, max)` helper: `string → NFC → trim → refine on
[...s].length`. Control characters (C0/C1 except `\n` in `description`) are rejected.

| Field            | Rule                                                          |
| ---------------- | ------------------------------------------------------------- |
| `title`          | required, 1–200 code points after trim                        |
| `nativeLanguage` | `languageCodeSchema` (allow-list `fr`, `en`)                  |
| `targetLanguage` | `languageCodeSchema`; must differ from `nativeLanguage`       |
| `description`    | optional, `string ≤ 2000` or `null`; `''` after trim → `null` |
| `topic`          | optional, `string 1–100` or `null`; `''` after trim → `null`  |

Fixed messages in `COLLECTION_MESSAGES` (added to `KNOWN_MESSAGES` in `server/utils/errors.ts`):
`titleRequired`, `titleTooLong`, `descriptionTooLong`, `topicTooLong`, `languagesSame` ("Choose two
different languages."), `languagesLocked` ("The languages can't be changed because this collection
already has words."), `archived` ("Unarchive this collection to edit it."), `confirmMismatch` ("Type
the collection title exactly to confirm."), `limitReached` ("You've reached the limit of 200
collections."), `invalidCursor`. Added during implementation: `invalidCharacters` (control characters or
malformed Unicode), `invalidText` (wrong type for description/topic), `noChanges` (empty `PATCH`).

### 2.2 Schemas

```ts
export const collectionIdParamsSchema = z.object({ id: z.uuid() }).strict()

export const listCollectionsQuerySchema = z.object({
  status: z.enum(['active', 'archived']).default('active'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(), // id of the last item of the previous page
}).strict()

export const createCollectionSchema = z.object({
  title, nativeLanguage, targetLanguage,
  description: description.optional(), topic: topic.optional(),
}).strict().refine(languagesDiffer, { path: ['targetLanguage'], message: COLLECTION_MESSAGES.languagesSame })

export const updateCollectionSchema = z.object({
  title: title.optional(), nativeLanguage: lang.optional(), targetLanguage: lang.optional(),
  description: description.optional(), topic: topic.optional(),
}).strict()
  .refine(atLeastOneKey)
  .refine(languagesDifferWhenBothGiven, { path: ['targetLanguage'], message: … })

export const deleteCollectionSchema = z.object({ confirmTitle: z.string().max(1000) }).strict()
export const emptyBodySchema = z.object({}).strict() // archive / unarchive; `undefined` body allowed

export const collectionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  nativeLanguage: languageCodeSchema,
  targetLanguage: languageCodeSchema,
  description: z.string().nullable(),
  topic: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  entryCount: z.number().int().nonnegative(),
}).strict()

export const collectionListSchema = z.object({
  items: z.array(collectionSchema), nextCursor: z.uuid().nullable(),
}).strict()
```

The DTO is built field by field (never spread a row): no `ownerId`, no `normalization` (LEX-010 owns
it). `entryCount` is a correlated `count(*)` on `vocabulary_entries` using the existing
`(collection_id, created_at, id)` index: cheap for ≤ 50 rows per page. The UI derives "languages
locked" from `entryCount > 0`; the server never trusts that and relies on RC002.

### 2.3 Routes (all session-only, `requireAuth(event)` first, Origin + JSON checks already global)

| Method + path                         | Input                              | Success              | Errors                                                                                                                            |
| ------------------------------------- | ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/collections`                | query `listCollectionsQuerySchema` | 200 `collectionList` | 400 (bad query; cursor not found or not owned → `invalidCursor`)                                                                  |
| `POST /api/collections`               | `createCollectionSchema`           | 201 `collection`     | 400; 409 `limitReached`                                                                                                           |
| `GET /api/collections/:id`            | params; query `{}` strict          | 200 `collection`     | 400 (non-uuid id); 404                                                                                                            |
| `PATCH /api/collections/:id`          | `updateCollectionSchema`           | 200 `collection`     | 400 (incl. 23514 `collections_languages_differ` → `languagesSame`); 404; 409 `languagesLocked` (SQLSTATE `RC002`); 409 `archived` |
| `POST /api/collections/:id/archive`   | `{}` or empty                      | 200 `collection`     | 404                                                                                                                               |
| `POST /api/collections/:id/unarchive` | `{}` or empty                      | 200 `collection`     | 404                                                                                                                               |
| `DELETE /api/collections/:id`         | `deleteCollectionSchema`           | 204                  | 400 `confirmMismatch` (issue on `confirmTitle`); 404                                                                              |

- **Ordering and keyset:** `ORDER BY created_at DESC, id DESC`, fetch `limit + 1`. The cursor is the
  last item's id; the page query is `(created_at, id) < (SELECT created_at, id FROM collections WHERE
id = $cursor AND owner_id = $user)`. This avoids encoding `timestamptz` microseconds in the cursor
  (JS `Date` only has milliseconds). A cursor whose row was deleted or belongs to someone else → 400
  `invalidCursor` (never reveals whether the id exists); the UI reloads from the first page.
- **Archive/unarchive are idempotent:** `archived_at = coalesce(archived_at, now())` /
  `archived_at = null`. Archiving twice keeps the first timestamp.
- **PATCH** sending unchanged languages is fine (RC002 only fires when the pair is `IS DISTINCT FROM`
  the old one). A single-language change is checked against the stored other language by the DB CHECK.
- **RC002 mapping:** the service catches `pgErrorInfo(e).code === 'RC002'` and returns
  `{ kind: 'languages_locked' }`; the handler throws `publicError(409, COLLECTION_MESSAGES.languagesLocked)`.
  Any other DB error stays a 500 with a fixed body.

## 3. Service layer (`server/services/collections/`)

```ts
// collections.service.ts — no imports from server/db/schema/srs (lint rule already enforces this)
export function listCollections(db: Db, userId: string, q: ListCollectionsQuery): Promise<ListResult>
export function getCollection(db: Db, userId: string, id: string): Promise<CollectionRow | null>
export function createCollection(db: Db, userId: string, input: CreateCollectionInput): Promise<CreateResult>
export function updateCollection(
  db: Db,
  userId: string,
  id: string,
  input: UpdateCollectionInput,
): Promise<UpdateResult>
export function setArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean,
): Promise<CollectionRow | null>
export function deleteCollection(
  db: Db,
  userId: string,
  id: string,
  confirmTitle: string,
): Promise<DeleteResult>
// dto.ts
export function toCollectionDto(row: CollectionRow): Collection
```

- **`db` is a parameter** (ADR 0002 §2.4). Handlers pass `useDb()`; integration tests pass
  `drizzle(connectAs('app'), { schema })`, so services run as the least-privilege role without Nitro.
  Services never read `event`.
- **Every statement has `owner_id = userId` in its `WHERE`** (including the cursor subquery and the
  entry-count subquery's parent). Foreign and missing rows look identical (`null` / `not_found`).
- Results are discriminated unions (`{ ok: true, row } | { ok: false, kind }`), mirroring the auth
  services. `CollectionRow` is internal and includes `ownerId`, so the handler can call
  `requireOwner(event, row, 'collection')`, which gives the 404 and the `access.denied` audit.
- **Create:** one transaction: `SELECT … FROM users WHERE id = $user FOR NO KEY UPDATE` (serializes
  parallel creates per user; the app role has column UPDATE on `users`, which `FOR NO KEY UPDATE`
  needs), count the user's collections, refuse over the cap (D3), `INSERT … RETURNING`.
- **Update:** one statement `UPDATE … WHERE id AND owner_id AND archived_at IS NULL RETURNING`. On 0
  rows, an owner-scoped `SELECT` tells `not_found` from `archived` (D2).
- **Delete:** one transaction: `DELETE … WHERE id AND owner_id AND title = $confirmTitle RETURNING id`
  (`confirmTitle` gets the same NFC + trim as titles). On 0 rows, an owner-scoped `SELECT` tells
  `not_found` from `mismatch`. Ownership is checked before the title is compared, so a foreign id is
  always 404. Cascades remove entries, cards, logs, and attempts (ADR 0001, X2). The handler writes a
  new audit event `collection.deleted` (resource `collection`, no title).

## 4. Defaults (client-side only)

`defaultLanguagePair(native: LanguageCode)` in `shared/constants/languages.ts`:
`{ nativeLanguage: native, targetLanguage: LANGUAGE_CODES.find((c) => c !== native)! }`. The create
form pre-fills from `useProfile()`'s `nativeLanguage`. The API never fills missing languages: both are
required, so changing the user's default later never touches existing collections (DEC-001).

## 5. Frontend (`app/**`, Nuxt UI v4)

Decision (small, made here): **pages, not modals, for create and edit.** Pages are deep-linkable, keep
the mobile keyboard and focus handling simple (existing `useKeepFocusedFieldVisible`), and avoid
nesting forms inside dialogs. `UModal` is used only for the delete confirmation (same pattern as
`/account`).

| Route                    | Content                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/collections`           | `h1`, "New collection" button, Active / Archived filter as two links with `aria-current` (`?status=archived`), list of `UCard` links (title, "French → English" pair as text, topic, word count, "Archived" badge with text). Empty state with a create link. "Load more" button; focus moves to the first new item. |
| `/collections/new`       | `UForm` + shared schema: title, native and target language (`FormNativeSelect`, not `USelect`, because of the CSP), description (`UTextarea`), topic. Defaults from §4. Submit → `/collections/:id`.                                                                                                                 |
| `/collections/[id]`      | Minimal detail page (LEX-005 fills it): metadata, "Edit", "Archive"/"Unarchive", "Delete…". "Words will appear here."                                                                                                                                                                                                |
| `/collections/[id]/edit` | Same form component. Language selects disabled when `entryCount > 0`, with a visible description explaining why; a 409 shows the fixed message in the error summary. Archived → read-only notice with "Unarchive".                                                                                                   |

- Components: `app/components/collections/CollectionForm.vue`, `CollectionCard.vue`,
  `DeleteCollectionDialog.vue` (states what is deleted: N words and their review and practice history;
  `UInput` "Type {title} to confirm", paste allowed; the confirm button stays enabled and a mismatch shows
  a text error, so disabled-button discoverability isn't an issue; focus returns to the trigger on close).
- `app/composables/useCollections.ts` (`$fetch` wrappers; 401 → `handleUnauthorized`),
  `app/utils/languages.ts` (move the `Intl.DisplayNames` labels out of `register.vue`).
- Nav: add "Collections" to `app/layouts/default.vue` and a "Your collections" button on `/dashboard`.
- Accessibility: visible labels, `FormErrorSummary` focus on failed submit, `aria-invalid`, text + icon
  for every status (archived, errors, success via a `role="status"` region), 44 px targets, focus to
  `h1` after navigation, no horizontal scroll at 320 px. Verify the CSP test passes on the new pages
  (no SSR inline `style` from Nuxt UI components).

## 6. Tests

### 6.1 Unit (`tests/unit/schemas/collections.test.ts`, `tests/unit/languages.test.ts`)

| #   | Case                                                                                                                                    | AC       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| U1  | Create: missing title/native/target → issue per field; `fr`/`fr` → `languagesSame` on `targetLanguage`                                  | VOC-01   |
| U2  | `de`, `EN`, `fra` rejected with `LANGUAGE_MESSAGE`                                                                                      | DEC-001  |
| U3  | Title: blank/whitespace rejected; 200 code points (incl. emoji / combining) accepted, 201 rejected; NFC applied; control chars rejected | VOC-01   |
| U4  | Description 2000/2001; topic 100/101; `''` → `null`                                                                                     | VOC-01   |
| U5  | Unknown keys (`ownerId`, `archivedAt`, `normalization`) rejected (strict) on create and update                                          | A01, A05 |
| U6  | Update: `{}` rejected; both languages equal rejected; a single language accepted                                                        | VOC-01   |
| U7  | List query: limit 0/51 rejected, default 20, unknown `status` rejected, non-uuid cursor rejected                                        | —        |
| U8  | `collectionSchema` has no `ownerId`; `toCollectionDto` output parses with it (strict)                                                   | A01      |
| U9  | `defaultLanguagePair('fr')` → en, `('en')` → fr, always differs                                                                         | §4       |
| U10 | `zodIssuesToPublic` keeps every `COLLECTION_MESSAGES` text                                                                              | A10      |

### 6.2 Integration (`tests/integration/collections.service.test.ts`, app role, services called with `db`)

| #   | Case                                                                                                            | AC      |
| --- | --------------------------------------------------------------------------------------------------------------- | ------- |
| I1  | Each service with user B's id on A's collection → `null`/`not_found`; A's row unchanged                         | rule 5  |
| I2  | Update languages with 0 entries → ok; after seeding an entry → `languages_locked`; same languages → ok          | DEC-001 |
| I3  | Keyset: 45 collections with identical `created_at` (inserted in one statement) → 3 pages, no duplicates or gaps | —       |
| I4  | Cap: 200 → the 201st is `limit_reached`; 10 parallel creates at 195 never exceed 200                            | D3      |
| I5  | Delete cascades (entry, cards, logs, attempts gone); another collection's `srs_*` rows are byte-identical       | rule 1  |
| I6  | Archive twice keeps the first `archived_at`; update on archived → `archived`                                    | D2      |

### 6.3 API black-box (`tests/api/collections.test.ts`)

| #   | Case                                                                                                                                                                                                     | AC               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| C1  | Journey: create (201) → get → list contains it → rename → archive → not in `active`, in `archived` → unarchive → delete (204) → get 404                                                                  | VOC-01           |
| C2  | **IDOR via `expectIdor` on all 7 routes** (list: B's list doesn't contain A's item, `status` 200; A's id as B's cursor → 400; get/patch/archive/unarchive/delete → 404); afterwards A's row is unchanged | issue AC, A01    |
| C3  | Validation: same languages → 400 issue on `targetLanguage`; `de` → 400; extra key `ownerId` → 400; non-uuid id → 400; bodies match `apiErrorSchema`, no input echoed                                     | VOC-01, A05      |
| C4  | RC002: seed an entry (migrator), PATCH `targetLanguage` → 409 with the fixed message; PATCH title alone → 200                                                                                            | DEC-001          |
| C5  | Delete confirmation: no body / `{}` / wrong title / `confirm: true` → 400 and the row still exists; correct title → 204                                                                                  | VOC-01 "confirm" |
| C6  | Pagination: 25 items, `limit=10` → 10/10/5, `nextCursor` null on the last page                                                                                                                           | —                |
| C7  | Response bodies never contain `ownerId`/`owner_id`/`normalization` (deep scan); created `owner_id` is the session user even if a body tries to set it (400)                                              | A01              |
| C8  | CSRF/JSON: POST/PATCH/DELETE with a foreign `Origin` → 403, `text/plain` → 415 (already global; one smoke case per method)                                                                               | A08              |
| C9  | Audit log has `collection.deleted` and `access.denied` (resource `collection`) lines; no titles in the log                                                                                               | A09              |

The A2 sweep (401 without a session) and U12 (`requireAuth` in every handler) cover the new files
automatically.

### 6.4 E2E (`tests/e2e/collections.spec.ts`, desktop + mobile projects, axe on every state)

- Create (defaults pre-filled from the native language; same-language error shown as text) → detail
  → rename → archive (badge text visible, moves to the Archived filter) → unarchive → delete (wrong
  title shows the error; correct title → back to `/collections`, item gone).
- Keyboard only on desktop: the whole flow, the dialog traps and returns focus, Escape cancels.
- Mobile: 320 px without horizontal scroll, targets ≥ 44 px, focused inputs visible.
- Dashboard and header link to `/collections`; the CSP test runs on the four new pages.

## 7. Files and owners

| File                                                                                                                               | Action | Owner    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| `shared/schemas/collections.ts`, `shared/schemas/text.ts` (`boundedText`)                                                          | create | backend  |
| `shared/constants/languages.ts` (`defaultLanguagePair`)                                                                            | modify | backend  |
| `server/services/collections/{collections.service,dto}.ts`                                                                         | create | backend  |
| `server/api/collections/index.{get,post}.ts`, `[id].{get,patch,delete}.ts`, `[id]/{archive,unarchive}.post.ts`                     | create | backend  |
| `server/utils/errors.ts` (known messages), `server/utils/audit.ts` (`collection.deleted`)                                          | modify | backend  |
| `app/pages/collections/{index,new}.vue`, `app/pages/collections/[id]/{index,edit}.vue`                                             | create | frontend |
| `app/components/collections/{CollectionForm,CollectionCard,DeleteCollectionDialog}.vue`                                            | create | frontend |
| `app/composables/useCollections.ts`, `app/utils/languages.ts`                                                                      | create | frontend |
| `app/layouts/default.vue`, `app/pages/dashboard.vue`, `app/pages/register.vue` (labels util)                                       | modify | frontend |
| `tests/unit/**`, `tests/integration/collections.service.test.ts`, `tests/api/collections.test.ts`, `tests/e2e/collections.spec.ts` | create | tester   |
| `docs/architecture.md` (§4 archive semantics, §12 log), README API list                                                            | modify | docs     |

## 8. Risks and invariants

1. **Ownership:** `owner_id` comes only from `requireAuth`; every query filters by it; foreign = missing
   = 404 (400 only for malformed input, which reveals nothing). The cursor is owner-scoped too.
2. **SRS isolation:** the collections module never imports `schema/srs`. The only effect on `srs_*` is
   the FK cascade on hard delete (accepted in ADR 0001); I5 proves other collections are untouched.
   Archiving changes nothing in `srs_cards` (D2).
3. **Language lock:** RC002 plus the `FOR SHARE` entry-insert lock (ADR 0001 L2) make it race-free;
   the API only maps the code. The UI hint is cosmetic.
4. **Destructive delete:** typed-title confirmation, ownership checked first, single transaction,
   audit event. Large collections cascade within the 10 s statement timeout (10k entries is the import
   cap); if that proves tight, LEX-006 measures it.
5. **Error safety:** all new messages are fixed strings; DB errors other than RC002 / the languages
   CHECK become a fixed 500.
6. **Accessibility:** archived status and errors are text + icon; dialog focus management; no USelect
   (CSP). Same patterns as `/account`.

## 9. Decisions (accepted)

| #   | Question                                                   | Options                                                                                                                                                                                                                                                                                | Recommendation                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Hard-delete confirmation**                               | (a) body `{ confirmTitle }` must equal the stored title (NFC + trim). (b) body `{ confirm: true }`. (c) must be archived first, then (a) or (b)                                                                                                                                        | **(a).** A boolean protects against nothing a client bug or a careless click can't also send; repeating the title proves the user saw _which_ collection is deleted, and the server re-checks it under the owner scope. (c) adds friction with little gain. |
| D2  | **What "archived" means app-wide** (binds LEX-005/007/011) | (a) Hidden from the default list; metadata and entries read-only (409 until unarchived); excluded from the review queue and practice pickers; cards keep their state untouched, so overdue cards are still due after unarchive. (b) Only a list filter; everything else works as usual | **(a).** Archiving should pause a collection without touching FSRS state (rule 1), and being read-only keeps "archived" honest. Unarchiving resumes exactly where it stopped.                                                                               |
| D3  | **Per-user collection cap**                                | (a) 200 collections per user, 409 when reached. (b) No cap (global IP limiter only)                                                                                                                                                                                                    | **(a).** A business limit enforced server-side (architecture §8 A06) that bounds storage abuse; 200 is far above realistic use and can be raised without a migration.                                                                                       |

**Accepted:** D1 = (a) `DELETE` body `{ confirmTitle }`, compared after NFC + trim with the stored title.
D2 = (a) archived collections are read-only (`PATCH` → 409 `archived`), hidden from the default list,
and later excluded from the review queue and practice pickers; FSRS cards are never touched by
archive/unarchive. D3 = (a) a cap of 200 collections per user (409 `limitReached`), enforced under
concurrency by the per-user `FOR NO KEY UPDATE` lock in the create transaction.

Small decisions made here (no approval needed): pages for create/edit; separate archive/unarchive
routes; `created_at desc` ordering; titles are not unique per user; no `updated_at` column (no
migration); audit event `collection.deleted`.

## 10. Consequences

- No schema change; LEX-005 builds on `entryCount` and the archived rules (D2).
- The `boundedText` helper and the code-point length rule become the convention for later text fields.
- LEX-007 (due queue) and LEX-011/012 (practice pickers) must filter `archived_at IS NULL` (D2).
