// Collection request/response contracts (ADR 0003 §2). Shared by the server handlers and the UI.
// Every object is `.strict()`: unknown keys (`ownerId`, `archivedAt`, `normalization`, …) are rejected.
import { z } from '../zod'
import { languageCodeSchema, type LanguageCode } from '../constants/languages'
import { boundedText } from './text'

export const COLLECTION_TITLE_MAX = 200
export const COLLECTION_DESCRIPTION_MAX = 2000
export const COLLECTION_TOPIC_MAX = 100
/** Per-user cap (ADR 0003 D3). Enforced by the service under a per-user lock. */
export const COLLECTION_LIMIT = 200
export const COLLECTION_PAGE_MAX = 50
export const COLLECTION_PAGE_DEFAULT = 20

/** Fixed, user-facing messages. The server sends exactly these strings (KNOWN_MESSAGES). */
export const COLLECTION_MESSAGES = Object.freeze({
  titleRequired: 'Enter a title.',
  titleTooLong: `Use at most ${COLLECTION_TITLE_MAX} characters for the title.`,
  descriptionTooLong: `Use at most ${COLLECTION_DESCRIPTION_MAX} characters for the description.`,
  topicTooLong: `Use at most ${COLLECTION_TOPIC_MAX} characters for the topic.`,
  /** Control characters (or malformed Unicode) in a text field. */
  invalidCharacters: 'Remove unsupported characters.',
  /** Wrong type for an optional text field (description, topic). */
  invalidText: 'Enter text or leave this field empty.',
  languagesSame: 'Choose two different languages.',
  /** 409 (SQLSTATE RC002, ADR 0001). */
  languagesLocked: "The languages can't be changed because this collection already has words.",
  /** 409 on edits to an archived collection (D2). */
  archived: 'Unarchive this collection to edit it.',
  /** PATCH with no field to change. */
  noChanges: 'Change at least one field.',
  /** 400 on delete (D1). */
  confirmMismatch: 'Type the collection title exactly to confirm.',
  /** 409 on create (D3). */
  limitReached: `You've reached the limit of ${COLLECTION_LIMIT} collections.`,
  /** 400 on list: the cursor is not one of the user's collections (deleted, or never existed). */
  invalidCursor: 'This list has changed. Reload it from the start.',
})

const title = boundedText({
  min: 1,
  max: COLLECTION_TITLE_MAX,
  messages: {
    required: COLLECTION_MESSAGES.titleRequired,
    tooLong: COLLECTION_MESSAGES.titleTooLong,
    invalidCharacters: COLLECTION_MESSAGES.invalidCharacters,
  },
})

/** `''` after trim → `null`; `null` stays `null`. */
const emptyToNull = (value: string | null): string | null => (value === '' ? null : value)

const description = boundedText({
  min: 0,
  max: COLLECTION_DESCRIPTION_MAX,
  multiline: true,
  messages: {
    required: COLLECTION_MESSAGES.invalidText,
    tooLong: COLLECTION_MESSAGES.descriptionTooLong,
    invalidCharacters: COLLECTION_MESSAGES.invalidCharacters,
  },
})
  .nullable()
  .transform(emptyToNull)

const topic = boundedText({
  min: 0, // '' becomes null, so a stored topic is always 1–100 code points
  max: COLLECTION_TOPIC_MAX,
  messages: {
    required: COLLECTION_MESSAGES.invalidText,
    tooLong: COLLECTION_MESSAGES.topicTooLong,
    invalidCharacters: COLLECTION_MESSAGES.invalidCharacters,
  },
})
  .nullable()
  .transform(emptyToNull)

type LanguagePairInput = { nativeLanguage?: unknown; targetLanguage?: unknown }

/** Run the "languages differ" check only when both languages parsed (so every field error is reported). */
function bothLanguagesParsed(payload: {
  value: unknown
  issues: ReadonlyArray<{ path?: PropertyKey[] }>
}): boolean {
  const v = payload.value as LanguagePairInput | undefined
  return (
    typeof v?.nativeLanguage === 'string' &&
    typeof v?.targetLanguage === 'string' &&
    !payload.issues.some(
      (issue) => issue.path?.[0] === 'nativeLanguage' || issue.path?.[0] === 'targetLanguage',
    )
  )
}

export const collectionIdParamsSchema = z.object({ id: z.uuid() }).strict()
export type CollectionIdParams = z.infer<typeof collectionIdParamsSchema>

/** `GET /api/collections/:id` takes no query parameters. */
export const emptyQuerySchema = z.object({}).strict()

export const listCollectionsQuerySchema = z
  .object({
    status: z.enum(['active', 'archived']).default('active'),
    limit: z.coerce.number().int().min(1).max(COLLECTION_PAGE_MAX).default(COLLECTION_PAGE_DEFAULT),
    /** Id of the last item of the previous page. */
    cursor: z.uuid().optional(),
  })
  .strict()
export type ListCollectionsQuery = z.output<typeof listCollectionsQuerySchema>

export const createCollectionSchema = z
  .object({
    title,
    nativeLanguage: languageCodeSchema,
    targetLanguage: languageCodeSchema,
    description: description.optional(),
    topic: topic.optional(),
  })
  .strict()
  .refine((v) => v.nativeLanguage !== v.targetLanguage, {
    path: ['targetLanguage'],
    error: COLLECTION_MESSAGES.languagesSame,
    when: bothLanguagesParsed,
  })
export type CreateCollectionInput = z.output<typeof createCollectionSchema>

export const updateCollectionSchema = z
  .object({
    title: title.optional(),
    nativeLanguage: languageCodeSchema.optional(),
    targetLanguage: languageCodeSchema.optional(),
    description: description.optional(),
    topic: topic.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    error: COLLECTION_MESSAGES.noChanges,
  })
  .refine((v) => v.nativeLanguage !== v.targetLanguage, {
    path: ['targetLanguage'],
    error: COLLECTION_MESSAGES.languagesSame,
    when: bothLanguagesParsed,
  })
export type UpdateCollectionInput = z.output<typeof updateCollectionSchema>

/** D1: the stored title, typed again. Same NFC + trim as titles; compared exactly by the service. */
export const deleteCollectionSchema = z
  .object({
    confirmTitle: z
      .string({ error: COLLECTION_MESSAGES.confirmMismatch })
      .max(1000, { error: COLLECTION_MESSAGES.confirmMismatch, abort: true })
      .normalize('NFC')
      .trim(),
  })
  .strict()
export type DeleteCollectionInput = z.output<typeof deleteCollectionSchema>

/** Archive / unarchive: `{}` or no body at all. */
export const emptyBodySchema = z.object({}).strict().optional()

/** The only collection shape that leaves the server. No `ownerId`, no `normalization` (LEX-010). */
export const collectionSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    nativeLanguage: languageCodeSchema,
    targetLanguage: languageCodeSchema,
    description: z.string().nullable(),
    topic: z.string().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    entryCount: z.number().int().nonnegative(),
  })
  .strict()
export type Collection = z.infer<typeof collectionSchema>

export const collectionListSchema = z
  .object({
    items: z.array(collectionSchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict()
export type CollectionList = z.infer<typeof collectionListSchema>

export type CollectionStatus = ListCollectionsQuery['status']
export type { LanguageCode }
