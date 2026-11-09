// The only place in app/** that talks to the collections API (ADR 0003 §2.3, §5).
// - Every mutating request sends a JSON body (`$fetch` sets `Content-Type: application/json`), even
//   archive/unarchive (`{}`): the server answers 415 to anything else.
// - Ids travel in the path (they are opaque UUIDs, not personal data). Titles never go in a URL:
//   the delete confirmation is a request body.
// - A 401 means the session expired or was revoked elsewhere: go to /login and come back here.
// - Collections are user content, so pages load them on the client only (like the profile), and
//   render them as text (no `v-html`).
import type {
  Collection,
  CollectionList,
  CollectionStatus,
  CreateCollectionInput,
  UpdateCollectionInput,
} from '#shared/schemas/collections'

/** Matches `z.uuid()` closely enough to skip a request for an obviously malformed route id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCollectionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function collectionPath(id: string): string {
  return `/collections/${encodeURIComponent(id)}`
}

function apiPath(id: string, suffix = ''): string {
  return `/api/collections/${encodeURIComponent(id)}${suffix}`
}

/** `?status=archived` selects the archived view; anything else is the active view. */
export function statusFromQuery(value: unknown): CollectionStatus {
  return value === 'archived' ? 'archived' : 'active'
}

export function useCollections() {
  const { handleUnauthorized } = useAuth()

  async function call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request()
    } catch (error) {
      if (toUiApiError(error).status === 401) await handleUnauthorized()
      throw error
    }
  }

  return {
    list: (query: { status: CollectionStatus; cursor?: string; limit?: number }) =>
      call(() => $fetch<CollectionList>('/api/collections', { query })),
    get: (id: string) => call(() => $fetch<Collection>(apiPath(id))),
    create: (body: CreateCollectionInput) =>
      call(() => $fetch<Collection>('/api/collections', { method: 'POST', body })),
    update: (id: string, body: UpdateCollectionInput) =>
      call(() => $fetch<Collection>(apiPath(id), { method: 'PATCH', body })),
    archive: (id: string) =>
      call(() => $fetch<Collection>(apiPath(id, '/archive'), { method: 'POST', body: {} })),
    unarchive: (id: string) =>
      call(() => $fetch<Collection>(apiPath(id, '/unarchive'), { method: 'POST', body: {} })),
    remove: (id: string, confirmTitle: string) =>
      call(() => $fetch(apiPath(id), { method: 'DELETE', body: { confirmTitle } }).then(() => undefined)),
  }
}

/**
 * Loads one collection on the client for the `[id]` pages. `notFound` covers 404 and a malformed id
 * (400): both mean "nothing here for you" and never reveal whether the id exists.
 */
export function useCollection(id: MaybeRefOrGetter<string>) {
  const api = useCollections()
  const collection = ref<Collection | null>(null)
  const state = ref<'loading' | 'ready' | 'not-found' | 'error'>('loading')
  const errorMessage = ref('')

  async function load() {
    const value = toValue(id)
    if (!isCollectionId(value)) {
      state.value = 'not-found'
      return
    }
    if (!collection.value) state.value = 'loading'
    try {
      collection.value = await api.get(value)
      state.value = 'ready'
    } catch (error) {
      const apiError = toUiApiError(error)
      if (apiError.status === 401) return
      collection.value = null
      if (apiError.status === 404 || apiError.status === 400) {
        state.value = 'not-found'
      } else {
        errorMessage.value = apiError.message
        state.value = 'error'
      }
    }
  }

  onMounted(load)
  watch(
    () => toValue(id),
    () => {
      collection.value = null
      void load()
    },
  )

  return { collection, state, errorMessage, reload: load }
}
