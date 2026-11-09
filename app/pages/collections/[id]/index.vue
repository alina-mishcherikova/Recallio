<script setup lang="ts">
// Collection detail (ADR 0003 §5). Minimal until LEX-005 adds the words. Archive and unarchive are
// one toggle button, so focus stays where it was and a status message announces the change.
import DeleteCollectionDialog from '~/components/collections/DeleteCollectionDialog.vue'
import LanguagePair from '~/components/collections/LanguagePair.vue'

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const api = useCollections()
const { collection, state, errorMessage, reload } = useCollection(id)

const heading = computed(() => {
  if (collection.value) return collection.value.title
  if (state.value === 'not-found') return 'Collection not found'
  if (state.value === 'error') return 'Collection'
  return 'Loading collection…'
})
useSeoMeta({ title: () => `${state.value === 'not-found' ? 'Not found' : 'Collection'} · Recallio` })

const archived = computed(() => !!collection.value?.archivedAt)
const words = computed(() => {
  const n = collection.value?.entryCount ?? 0
  return n === 1 ? '1 word' : `${n} words`
})
const createdOn = computed(() =>
  collection.value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date(collection.value.createdAt))
    : '',
)

const toggling = ref(false)
const actionStatus = ref('')
const actionError = ref('')

// Not `loading`: a disabled button drops keyboard focus. Double clicks are ignored instead.
const toggleLabel = computed(() => {
  if (toggling.value) return archived.value ? 'Unarchiving…' : 'Archiving…'
  return archived.value ? 'Unarchive' : 'Archive'
})

async function toggleArchived() {
  if (!collection.value || toggling.value) return
  toggling.value = true
  actionError.value = ''
  actionStatus.value = ''
  const wasArchived = archived.value
  try {
    collection.value = wasArchived
      ? await api.unarchive(collection.value.id)
      : await api.archive(collection.value.id)
    actionStatus.value = wasArchived
      ? 'Collection unarchived. You can edit it again.'
      : 'Collection archived. It is read-only until you unarchive it.'
  } catch (error) {
    const apiError = toUiApiError(error)
    if (apiError.status === 401) return
    if (apiError.status === 404) {
      await reload()
      return
    }
    actionError.value = apiError.message
  } finally {
    toggling.value = false
  }
}

const deleteOpen = ref(false)

async function onDeleted({ alreadyGone }: { alreadyGone: boolean }) {
  const wasArchived = archived.value
  await navigateTo(wasArchived ? { path: '/collections', query: { status: 'archived' } } : '/collections')
  await focusPageHeading()
  useToast().add({
    title: alreadyGone ? 'This collection had already been deleted.' : 'Collection deleted.',
    icon: 'i-lucide-circle-check',
    color: 'success',
  })
}
</script>

<template>
  <UContainer class="flex max-w-3xl flex-col gap-8 py-8 sm:py-12">
    <div class="flex flex-col gap-2">
      <ULink
        to="/collections"
        class="inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-primary underline underline-offset-2"
      >
        <UIcon name="i-lucide-arrow-left" aria-hidden="true" class="size-4" />
        All collections
      </ULink>
      <h1 tabindex="-1" class="text-3xl font-bold tracking-tight break-words focus:outline-none">
        {{ heading }}
      </h1>
    </div>

    <p v-if="state === 'loading'" role="status" class="text-muted">Loading the collection…</p>

    <div v-else-if="state === 'not-found'" class="flex flex-col items-start gap-3">
      <p>This collection doesn't exist, or it was deleted.</p>
      <UButton
        to="/collections"
        color="neutral"
        variant="outline"
        label="Go to your collections"
        class="min-h-11 min-w-11"
      />
    </div>

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
        @click="() => reload()"
      />
    </div>

    <template v-else-if="collection">
      <div class="flex flex-col gap-4">
        <p class="flex flex-wrap items-center gap-3 text-lg">
          <LanguagePair
            :native-language="collection.nativeLanguage"
            :target-language="collection.targetLanguage"
            class="font-semibold"
          />
          <UBadge
            v-if="archived"
            color="neutral"
            variant="subtle"
            size="lg"
            icon="i-lucide-archive"
            label="Archived"
            data-testid="archived-badge"
          />
        </p>
        <p v-if="archived" class="flex items-start gap-2 text-muted">
          <UIcon name="i-lucide-info" aria-hidden="true" class="mt-1 size-4 shrink-0" />
          <span>This collection is archived and read-only. Unarchive it to edit it.</span>
        </p>

        <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]" data-testid="collection-details">
          <dt class="font-medium">Your language</dt>
          <dd class="text-muted">{{ languageLabel(collection.nativeLanguage) }}</dd>
          <dt class="font-medium">Language you're learning</dt>
          <dd class="text-muted">{{ languageLabel(collection.targetLanguage) }}</dd>
          <template v-if="collection.topic">
            <dt class="font-medium">Topic</dt>
            <dd class="break-words text-muted">{{ collection.topic }}</dd>
          </template>
          <template v-if="collection.description">
            <dt class="font-medium">Description</dt>
            <dd class="break-words whitespace-pre-line text-muted">{{ collection.description }}</dd>
          </template>
          <dt class="font-medium">Words</dt>
          <dd class="text-muted">{{ words }}</dd>
          <dt class="font-medium">Created</dt>
          <dd class="text-muted">{{ createdOn }}</dd>
        </dl>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <UButton
          v-if="!archived"
          :to="`${collectionPath(collection.id)}/edit`"
          icon="i-lucide-pencil"
          size="lg"
          label="Edit"
          class="min-h-11 min-w-11 justify-center"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          :icon="archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
          :aria-busy="toggling"
          :label="toggleLabel"
          class="min-h-11 min-w-11 justify-center"
          @click="toggleArchived"
        />
        <UButton
          color="error"
          variant="outline"
          size="lg"
          icon="i-lucide-trash"
          label="Delete…"
          class="min-h-11 min-w-11 justify-center"
          @click="deleteOpen = true"
        />
      </div>
      <p role="status" class="flex items-center gap-2 text-sm" data-testid="action-status">
        <template v-if="actionStatus">
          <UIcon name="i-lucide-circle-check" aria-hidden="true" class="size-4 shrink-0 text-success" />
          <span>{{ actionStatus }}</span>
        </template>
      </p>
      <p v-if="actionError" role="alert" class="flex items-center gap-2 text-sm text-error">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
        <span>{{ actionError }}</span>
      </p>

      <section aria-labelledby="words-heading" class="flex flex-col gap-2">
        <h2 id="words-heading" class="text-xl font-semibold">Words</h2>
        <p class="text-muted">Words will appear here.</p>
      </section>

      <DeleteCollectionDialog v-model:open="deleteOpen" :collection="collection" @deleted="onDeleted" />
    </template>
  </UContainer>
</template>
