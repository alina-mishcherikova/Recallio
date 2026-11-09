<script setup lang="ts">
// Create a collection (ADR 0003 §4, §5). The languages are pre-filled from the profile's native
// language once it has loaded; the API never fills them in.
import { defaultLanguagePair } from '#shared/constants/languages'
import type { CreateCollectionInput } from '#shared/schemas/collections'
import CollectionForm, { type CollectionFormValues } from '~/components/collections/CollectionForm.vue'

useSeoMeta({ title: 'New collection · Recallio' })

const api = useCollections()
const { data: user } = useProfile()
const form = useTemplateRef('form')

const initial: CollectionFormValues = {
  title: '',
  nativeLanguage: undefined,
  targetLanguage: undefined,
  description: '',
  topic: '',
}

watch(
  [user, form],
  ([profile, formRef]) => {
    if (profile && formRef) formRef.applyLanguageDefaults(defaultLanguagePair(profile.nativeLanguage))
  },
  { immediate: true },
)

async function create(values: CreateCollectionInput) {
  const created = await api.create(values)
  await navigateTo(collectionPath(created.id))
  await focusPageHeading()
  useToast().add({ title: 'Collection created.', icon: 'i-lucide-circle-check', color: 'success' })
}
</script>

<template>
  <UContainer class="flex max-w-2xl flex-col gap-6 py-8 sm:py-12">
    <div class="flex flex-col gap-2">
      <ULink
        to="/collections"
        class="inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-primary underline underline-offset-2"
      >
        <UIcon name="i-lucide-arrow-left" aria-hidden="true" class="size-4" />
        All collections
      </ULink>
      <h1 tabindex="-1" class="text-3xl font-bold tracking-tight focus:outline-none">New collection</h1>
    </div>

    <CollectionForm
      ref="form"
      :initial="initial"
      :submit="create"
      submit-label="Create collection"
      pending-label="Creating…"
      pending-status="Creating the collection…"
      cancel-to="/collections"
    />
  </UContainer>
</template>
