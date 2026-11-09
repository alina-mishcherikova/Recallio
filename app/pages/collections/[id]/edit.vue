<script setup lang="ts">
// Edit a collection (ADR 0003 §5). Archived collections are read-only (D2): the page shows a notice
// with "Unarchive" instead of the form. When the collection has words, the languages are locked
// (RC002); the server is the authority and answers 409, which the form shows as text.
import type { CreateCollectionInput, UpdateCollectionInput } from '#shared/schemas/collections'
import CollectionForm, { type CollectionFormValues } from '~/components/collections/CollectionForm.vue'
import LanguagePair from '~/components/collections/LanguagePair.vue'

useSeoMeta({ title: 'Edit collection · Recallio' })

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const api = useCollections()
const { collection, state, errorMessage, reload } = useCollection(id)
const form = useTemplateRef('form')

const archived = computed(() => !!collection.value?.archivedAt)
const languagesLocked = computed(() => (collection.value?.entryCount ?? 0) > 0)
const detailPath = computed(() => collectionPath(id.value))

/** Rebuilt when the collection reloads (after a 409 or an unarchive), so the form starts fresh. */
const formKey = ref(0)
const initial = computed<CollectionFormValues>(() => ({
  title: collection.value?.title ?? '',
  nativeLanguage: collection.value?.nativeLanguage,
  targetLanguage: collection.value?.targetLanguage,
  description: collection.value?.description ?? '',
  topic: collection.value?.topic ?? '',
}))

async function save(values: CreateCollectionInput) {
  // Locked languages are never sent; unchanged ones are harmless (RC002 only fires on a change).
  const body: UpdateCollectionInput = languagesLocked.value
    ? { title: values.title, description: values.description, topic: values.topic }
    : values
  try {
    await api.update(id.value, body)
  } catch (error) {
    // 409: the languages got locked or the collection was archived meanwhile. Refresh what the
    // page knows (lock hint, archived notice) and let the form show the server's message.
    if (toUiApiError(error).status === 409) {
      await reload()
      if (archived.value) await focusPageHeading()
    }
    throw error
  }
  await navigateTo(detailPath.value)
  await focusPageHeading()
  useToast().add({ title: 'Changes saved.', icon: 'i-lucide-circle-check', color: 'success' })
}

const unarchiving = ref(false)
const unarchiveError = ref('')

async function unarchive() {
  if (unarchiving.value) return
  unarchiving.value = true
  unarchiveError.value = ''
  try {
    collection.value = await api.unarchive(id.value)
    formKey.value++
    await nextTick()
    // The button is gone: continue in the form.
    form.value?.focusTitle()
  } catch (error) {
    const apiError = toUiApiError(error)
    if (apiError.status === 401) return
    if (apiError.status === 404) {
      await reload()
      return
    }
    unarchiveError.value = apiError.message
  } finally {
    unarchiving.value = false
  }
}
</script>

<template>
  <UContainer class="flex max-w-2xl flex-col gap-6 py-8 sm:py-12">
    <div class="flex flex-col gap-2">
      <ULink
        :to="state === 'not-found' ? '/collections' : detailPath"
        class="inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-primary underline underline-offset-2"
      >
        <UIcon name="i-lucide-arrow-left" aria-hidden="true" class="size-4" />
        {{ state === 'not-found' ? 'All collections' : 'Back to the collection' }}
      </ULink>
      <h1 tabindex="-1" class="text-3xl font-bold tracking-tight focus:outline-none">
        {{ state === 'not-found' ? 'Collection not found' : 'Edit collection' }}
      </h1>
      <p v-if="collection" class="text-muted">
        <span class="break-words font-medium text-default">{{ collection.title }}</span>
        ·
        <LanguagePair
          :native-language="collection.nativeLanguage"
          :target-language="collection.targetLanguage"
        />
      </p>
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

    <div
      v-else-if="collection && archived"
      class="flex flex-col items-start gap-3 rounded-md border border-default p-4"
      data-testid="archived-notice"
    >
      <p class="flex items-start gap-2">
        <UIcon name="i-lucide-archive" aria-hidden="true" class="mt-1 size-4 shrink-0" />
        <span>This collection is archived, so it's read-only. Unarchive it to edit it.</span>
      </p>
      <UButton
        icon="i-lucide-archive-restore"
        size="lg"
        :aria-busy="unarchiving"
        :label="unarchiving ? 'Unarchiving…' : 'Unarchive'"
        class="min-h-11 min-w-11 justify-center"
        @click="unarchive"
      />
      <p v-if="unarchiveError" role="alert" class="flex items-center gap-2 text-sm text-error">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
        <span>{{ unarchiveError }}</span>
      </p>
    </div>

    <CollectionForm
      v-else-if="collection"
      ref="form"
      :key="formKey"
      :initial="initial"
      :languages-locked="languagesLocked"
      :submit="save"
      submit-label="Save changes"
      pending-label="Saving…"
      pending-status="Saving your changes…"
      :cancel-to="detailPath"
    />
  </UContainer>
</template>
