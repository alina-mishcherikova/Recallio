<script setup lang="ts">
// Collection list (ADR 0003 §5): Active / Archived views as links (`?status=archived`), newest
// first, keyset "Load more". Loaded on the client only (user content, like the profile).
import type { Collection } from '#shared/schemas/collections'
import CollectionCard from '~/components/collections/CollectionCard.vue'

useSeoMeta({ title: 'Collections · Recallio' })

const route = useRoute()
const api = useCollections()

const view = computed(() => statusFromQuery(route.query.status))
const VIEWS = [
  { status: 'active', label: 'Active', to: { path: '/collections' } },
  { status: 'archived', label: 'Archived', to: { path: '/collections', query: { status: 'archived' } } },
] as const

const items = ref<Collection[]>([])
const nextCursor = ref<string | null>(null)
const state = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const loadingMore = ref(false)
const loadMoreError = ref('')
const announcement = ref('')
/** Ignores responses for a view the user has already left. */
let generation = 0

async function loadFirstPage(message = '') {
  const current = ++generation
  state.value = 'loading'
  loadMoreError.value = ''
  announcement.value = message
  try {
    const page = await api.list({ status: view.value })
    if (current !== generation) return
    items.value = page.items
    nextCursor.value = page.nextCursor
    state.value = 'ready'
  } catch (error) {
    if (current !== generation) return
    const apiError = toUiApiError(error)
    if (apiError.status === 401) return
    errorMessage.value = apiError.message
    state.value = 'error'
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  const current = generation
  const firstNew = items.value.length
  loadingMore.value = true
  loadMoreError.value = ''
  try {
    const page = await api.list({ status: view.value, cursor: nextCursor.value })
    if (current !== generation) return
    items.value = [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
    const added = page.items.length
    announcement.value = `Loaded ${added} more ${added === 1 ? 'collection' : 'collections'}.`
    // Keyboard and screen-reader users continue at the first new item, not back at the button.
    await nextTick()
    const first = items.value[firstNew]
    if (first) document.getElementById(`collection-link-${first.id}`)?.focus()
  } catch (error) {
    const apiError = toUiApiError(error)
    if (apiError.status === 401) return
    // 400 = the cursor is gone (that collection was deleted meanwhile): start again from the top.
    if (apiError.status === 400) {
      await loadFirstPage(apiError.message)
      await focusPageHeading()
      return
    }
    loadMoreError.value = apiError.message
  } finally {
    loadingMore.value = false
  }
}

onMounted(() => loadFirstPage())
watch(view, () => loadFirstPage())

const countText = computed(() => {
  const n = items.value.length
  const noun = n === 1 ? 'collection' : 'collections'
  const label = view.value === 'archived' ? 'archived' : 'active'
  return nextCursor.value ? `Showing the ${n} newest ${label} ${noun}.` : `${n} ${label} ${noun}.`
})
</script>

<template>
  <UContainer class="flex max-w-3xl flex-col gap-6 py-8 sm:py-12">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 tabindex="-1" class="text-3xl font-bold tracking-tight focus:outline-none">Collections</h1>
      <UButton
        to="/collections/new"
        icon="i-lucide-plus"
        size="lg"
        label="New collection"
        class="min-h-11 min-w-11 justify-center"
      />
    </div>

    <nav aria-label="Collection views">
      <ul class="flex gap-2 border-b border-default">
        <li v-for="item in VIEWS" :key="item.status">
          <NuxtLink
            :to="item.to"
            :aria-current="view === item.status ? 'page' : 'false'"
            :class="[
              '-mb-px inline-flex min-h-11 min-w-11 items-center justify-center rounded-t-md border-b-2 px-4 text-base',
              view === item.status
                ? 'border-primary font-semibold text-highlighted underline decoration-2 underline-offset-8'
                : 'border-transparent text-muted hover:text-default',
            ]"
            >{{ item.label }}</NuxtLink
          >
        </li>
      </ul>
    </nav>

    <p class="sr-only" role="status">{{ announcement }}</p>

    <p v-if="state === 'loading'" role="status" class="flex items-center gap-2 text-muted">
      <UIcon
        name="i-lucide-loader-circle"
        aria-hidden="true"
        class="size-4 shrink-0 motion-safe:animate-spin"
      />
      Loading collections…
    </p>

    <div v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center gap-3">
      <span class="flex items-center gap-2">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
        {{ errorMessage }}
      </span>
      <UButton
        color="neutral"
        variant="outline"
        label="Try again"
        class="min-h-11 min-w-11"
        @click="() => loadFirstPage()"
      />
    </div>

    <div
      v-else-if="items.length === 0"
      class="flex flex-col items-start gap-3 rounded-md border border-dashed border-accented p-6"
      data-testid="collections-empty"
    >
      <UIcon name="i-lucide-folder-open" aria-hidden="true" class="size-8 text-muted" />
      <template v-if="view === 'active'">
        <p class="text-lg font-semibold">You don't have any collections yet.</p>
        <p class="text-muted">
          A collection holds words for one language pair, for example English → French.
        </p>
        <UButton
          to="/collections/new"
          icon="i-lucide-plus"
          size="lg"
          label="Create your first collection"
          class="min-h-11 min-w-11 justify-center"
        />
      </template>
      <template v-else>
        <p class="text-lg font-semibold">No archived collections.</p>
        <p class="text-muted">Archived collections are read-only and kept out of your active list.</p>
        <UButton
          to="/collections"
          color="neutral"
          variant="outline"
          size="lg"
          label="Show active collections"
          class="min-h-11 min-w-11 justify-center"
        />
      </template>
    </div>

    <template v-else>
      <p class="text-sm text-muted" data-testid="collections-count">{{ countText }}</p>
      <ul class="flex flex-col gap-3" data-testid="collection-list">
        <li v-for="collection in items" :key="collection.id">
          <CollectionCard :collection="collection" />
        </li>
      </ul>
      <div v-if="nextCursor" class="flex flex-col items-start gap-2">
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          :loading="loadingMore"
          :label="loadingMore ? 'Loading…' : 'Load more'"
          class="min-h-11 min-w-11 justify-center"
          @click="loadMore"
        />
      </div>
      <p v-if="loadMoreError" role="alert" class="flex items-center gap-2 text-sm text-error">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
        <span>{{ loadMoreError }}</span>
      </p>
    </template>
  </UContainer>
</template>
