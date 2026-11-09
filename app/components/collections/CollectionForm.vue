<script setup lang="ts">
// Create and edit form for a collection (ADR 0003 §5). Validates with the shared schema (UX only:
// the server re-validates), reports problems in the focused error summary and inline, and maps the
// server's 400 issues and fixed 409 messages. The page decides what to send and where to go next.
import type { FormError, FormErrorEvent } from '@nuxt/ui'
import type { LanguageCode } from '#shared/constants/languages'
import {
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_MESSAGES,
  COLLECTION_TITLE_MAX,
  COLLECTION_TOPIC_MAX,
  createCollectionSchema,
  type CreateCollectionInput,
} from '#shared/schemas/collections'
import type { SummaryItem } from '~/components/auth/FormErrorSummary.vue'

export interface CollectionFormValues {
  title: string
  nativeLanguage: LanguageCode | undefined
  targetLanguage: LanguageCode | undefined
  description: string
  topic: string
}

const props = withDefaults(
  defineProps<{
    initial: CollectionFormValues
    submitLabel: string
    pendingLabel: string
    pendingStatus: string
    cancelTo: string
    /** The collection has words: the languages can't change (RC002). */
    languagesLocked?: boolean
    /** Throws the `$fetch` error on failure; the form shows it. */
    submit: (values: CreateCollectionInput) => Promise<void>
  }>(),
  { languagesLocked: false },
)

const FIELD_IDS = {
  title: 'collection-title',
  nativeLanguage: 'collection-native-language',
  targetLanguage: 'collection-target-language',
  description: 'collection-description',
  topic: 'collection-topic',
} as const

const state = reactive<CollectionFormValues>({ ...props.initial })
const languagesTouched = ref(false)

const form = useTemplateRef('form')
const summary = ref<SummaryItem[]>([])
const attempted = ref(false)
const status = ref('')

const validate = (): FormError[] => mergeFieldErrors(schemaFormErrors(createCollectionSchema, state))

function toSummary(errors: { name?: string; message: string }[]): SummaryItem[] {
  // Disabled selects can't take focus, so a locked language error has no link.
  const locked = (name: string) => props.languagesLocked && /^(native|target)Language$/.test(name)
  return errors.map(({ name, message }) => ({
    message,
    id: name && !locked(name) ? FIELD_IDS[name as keyof typeof FIELD_IDS] : undefined,
  }))
}

function onError(event: FormErrorEvent) {
  attempted.value = true
  summary.value = event.errors.map(({ id, message }) => ({ id, message }))
}

async function onSubmit() {
  attempted.value = true
  const parsed = createCollectionSchema.safeParse(state)
  if (!parsed.success) return // `validate` already reported it
  summary.value = []
  status.value = props.pendingStatus
  try {
    await props.submit(parsed.data)
  } catch (error) {
    status.value = ''
    const apiError = toUiApiError(error)
    if (apiError.status === 401) return // redirected to /login
    if (apiError.issues.length) {
      const fieldErrors = mergeFieldErrors(apiError.issues.map((i) => ({ name: i.path, message: i.message })))
      form.value?.setErrors(fieldErrors)
      summary.value = toSummary(fieldErrors)
      return
    }
    summary.value = [{ message: apiError.message }]
  }
}

/** Fills in the language defaults once the profile has loaded, unless the user already chose. */
function applyLanguageDefaults(pair: { nativeLanguage: LanguageCode; targetLanguage: LanguageCode }) {
  if (languagesTouched.value) return
  state.nativeLanguage = pair.nativeLanguage
  state.targetLanguage = pair.targetLanguage
}

/** Moves focus to the title field (for example after unarchiving on the edit page). */
function focusTitle() {
  focusById(FIELD_IDS.title)
}

defineExpose({ applyLanguageDefaults, focusTitle })

const DESCRIPTION_HELP = `Optional. Up to ${COLLECTION_DESCRIPTION_MAX} characters.`
const TOPIC_HELP = `Optional, for example “Travel” or “Work”. Up to ${COLLECTION_TOPIC_MAX} characters.`
const TITLE_HELP = `Up to ${COLLECTION_TITLE_MAX} characters.`
</script>

<template>
  <div class="flex flex-col gap-6">
    <AuthFormErrorSummary :errors="summary" />

    <UForm
      ref="form"
      :state="state"
      :validate="validate"
      :validate-on="attempted ? ['input', 'blur', 'change'] : []"
      class="flex flex-col gap-6"
      novalidate
      @submit="onSubmit"
      @error="onError"
    >
      <template #default="{ loading }">
        <UFormField label="Title" name="title" :description="TITLE_HELP" size="xl" required>
          <UInput
            :id="FIELD_IDS.title"
            v-model="state.title"
            autocomplete="off"
            size="xl"
            class="w-full"
            :ui="{ base: 'min-h-12' }"
          />
        </UFormField>

        <fieldset class="flex flex-col gap-4 rounded-md border border-default p-4">
          <legend class="px-1 text-base font-semibold">Languages</legend>
          <p class="text-sm text-muted">
            Words go from your language to the one you're learning, and back. For example, English → French.
          </p>
          <p
            v-if="languagesLocked"
            class="flex items-start gap-2 text-sm text-default"
            data-testid="languages-locked"
          >
            <UIcon name="i-lucide-info" aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
            <span>{{ COLLECTION_MESSAGES.languagesLocked }}</span>
          </p>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Your language"
              name="nativeLanguage"
              description="The language you already know."
              size="xl"
              required
            >
              <FormNativeSelect
                :id="FIELD_IDS.nativeLanguage"
                v-model="state.nativeLanguage"
                :items="LANGUAGE_ITEMS"
                :disabled="languagesLocked"
                placeholder="Choose a language"
                @change="languagesTouched = true"
              />
            </UFormField>
            <UFormField
              label="Language you're learning"
              name="targetLanguage"
              description="The language of the words you add."
              size="xl"
              required
            >
              <FormNativeSelect
                :id="FIELD_IDS.targetLanguage"
                v-model="state.targetLanguage"
                :items="LANGUAGE_ITEMS"
                :disabled="languagesLocked"
                placeholder="Choose a language"
                @change="languagesTouched = true"
              />
            </UFormField>
          </div>
        </fieldset>

        <UFormField label="Description" name="description" :description="DESCRIPTION_HELP" size="xl">
          <UTextarea
            :id="FIELD_IDS.description"
            v-model="state.description"
            :rows="4"
            size="xl"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Topic" name="topic" :description="TOPIC_HELP" size="xl">
          <UInput
            :id="FIELD_IDS.topic"
            v-model="state.topic"
            autocomplete="off"
            size="xl"
            class="w-full"
            :ui="{ base: 'min-h-12' }"
          />
        </UFormField>

        <div class="flex flex-col gap-3 sm:flex-row">
          <UButton
            type="submit"
            size="xl"
            :loading="loading"
            :label="loading ? pendingLabel : submitLabel"
            class="min-h-12 min-w-11 justify-center"
          />
          <UButton
            :to="cancelTo"
            color="neutral"
            variant="outline"
            size="xl"
            label="Cancel"
            class="min-h-12 min-w-11 justify-center"
          />
        </div>
        <p class="sr-only" role="status">{{ status }}</p>
      </template>
    </UForm>
  </div>
</template>
