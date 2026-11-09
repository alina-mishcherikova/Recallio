<script setup lang="ts">
// Delete confirmation (ADR 0003 D1). The user types the collection's title again; the server
// re-checks it under the owner scope. The confirm button stays enabled: a mismatch shows a text
// error on the field, so nobody has to guess why a button is disabled. Paste is allowed.
// Focus: the field gets it on open (first focusable element); Cancel or Escape return it to the
// trigger; after a successful delete the page moves it (the trigger is gone).
import { COLLECTION_MESSAGES, deleteCollectionSchema, type Collection } from '#shared/schemas/collections'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ collection: Pick<Collection, 'id' | 'title' | 'entryCount'> }>()
const emit = defineEmits<{
  /** `alreadyGone`: the collection no longer existed (404), for example deleted in another tab. */
  deleted: [result: { alreadyGone: boolean }]
}>()

const INPUT_ID = 'delete-collection-confirm'

const api = useCollections()
const confirmTitle = ref('')
const fieldError = ref<string | undefined>()
const formError = ref('')
const deleting = ref(false)
const status = ref('')
let done = false

const consequences = computed(() => {
  const { title, entryCount } = props.collection
  const words = entryCount === 1 ? '1 word' : `${entryCount} words`
  return entryCount > 0
    ? `“${title}” and its ${words} will be deleted, with their review schedule and history and practice results. This can't be undone.`
    : `“${title}” will be deleted. This can't be undone.`
})

watch(open, (isOpen) => {
  if (!isOpen) return
  confirmTitle.value = ''
  fieldError.value = undefined
  formError.value = ''
  status.value = ''
  done = false
})

const normalize = (s: string) => s.normalize('NFC').trim()

async function onConfirm() {
  formError.value = ''
  const parsed = deleteCollectionSchema.safeParse({ confirmTitle: confirmTitle.value })
  // UX check only: the server compares the title again and is the authority.
  if (!parsed.success || parsed.data.confirmTitle !== normalize(props.collection.title)) {
    fieldError.value = COLLECTION_MESSAGES.confirmMismatch
    focusById(INPUT_ID)
    return
  }
  fieldError.value = undefined
  deleting.value = true
  status.value = 'Deleting the collection…'
  try {
    await api.remove(props.collection.id, parsed.data.confirmTitle)
    finish(false)
  } catch (error) {
    status.value = ''
    const apiError = toUiApiError(error)
    if (apiError.status === 401) {
      open.value = false
      return
    }
    if (apiError.status === 404) {
      finish(true)
      return
    }
    const issue = apiError.issues.find((i) => i.path === 'confirmTitle')
    if (issue) {
      fieldError.value = issue.message
      focusById(INPUT_ID)
    } else {
      formError.value = apiError.message
    }
  } finally {
    deleting.value = false
  }
}

function finish(alreadyGone: boolean) {
  done = true
  open.value = false
  emit('deleted', { alreadyGone })
}

/** After a delete, the trigger is gone: the page moves focus instead of the dialog. */
function onCloseAutoFocus(event: Event) {
  if (done) event.preventDefault()
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Delete this collection?"
    :description="consequences"
    :dismissible="!deleting"
    :close="false"
    :content="{ onCloseAutoFocus }"
  >
    <template #body>
      <form class="flex flex-col gap-5" novalidate @submit.prevent="onConfirm">
        <UFormField
          label="Type the collection title to confirm"
          name="confirmTitle"
          :description="`The title is “${collection.title}”.`"
          :error="fieldError"
          size="xl"
        >
          <UInput
            :id="INPUT_ID"
            v-model="confirmTitle"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            size="xl"
            class="w-full"
            :ui="{ base: 'min-h-12' }"
          />
        </UFormField>

        <p v-if="formError" role="alert" class="flex items-center gap-2 text-sm text-error">
          <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
          <span>{{ formError }}</span>
        </p>

        <div class="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <UButton
            color="neutral"
            variant="outline"
            size="lg"
            label="Cancel"
            :disabled="deleting"
            class="min-h-11 min-w-11 justify-center"
            @click="open = false"
          />
          <UButton
            type="submit"
            color="error"
            size="lg"
            icon="i-lucide-trash"
            :loading="deleting"
            :label="deleting ? 'Deleting…' : 'Delete collection'"
            class="min-h-11 min-w-11 justify-center"
          />
        </div>
        <p class="sr-only" role="status">{{ status }}</p>
      </form>
    </template>
  </UModal>
</template>
