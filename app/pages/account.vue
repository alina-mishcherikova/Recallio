<script setup lang="ts">
import type { FormError, FormErrorEvent } from '@nuxt/ui'
import { deleteAccountRequestSchema } from '#shared/schemas/auth'
import type { SummaryItem } from '~/components/auth/FormErrorSummary.vue'

useSeoMeta({ title: 'Account · Recallio' })

const PASSWORD_ID = 'delete-account-password'

const { logout, deleteAccount, handleUnauthorized } = useAuth()
const { data: user, status: profileStatus, refresh } = useProfile()

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
const memberSince = computed(() =>
  user.value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date(user.value.createdAt))
    : '',
)

// ── Logout ────────────────────────────────────────────────────────────────────────────────────────
const logoutPending = ref<'current' | 'all' | null>(null)
const logoutError = ref('')

async function onLogout(scope: 'current' | 'all') {
  logoutPending.value = scope
  logoutError.value = ''
  try {
    await logout(scope)
  } catch (error) {
    logoutError.value = toUiApiError(error).message
  } finally {
    logoutPending.value = null
  }
}

// ── Delete account ───────────────────────────────────────────────────────────────────────────────
// Two explicit steps: re-enter the current password, then confirm in a dialog.
const form = useTemplateRef('form')
const state = reactive({ password: '' })
const attempted = ref(false)
const summary = ref<SummaryItem[]>([])
const confirmOpen = ref(false)
const deleting = ref(false)
const status = ref('')
/** Errors to show once the dialog has closed (so focus goes to the summary, not the trigger). */
let pendingErrors: { summary: SummaryItem[]; field?: FormError[] } | null = null

const validate = (s: typeof state): FormError[] =>
  mergeFieldErrors(schemaFormErrors(deleteAccountRequestSchema, s))

function onError(event: FormErrorEvent) {
  attempted.value = true
  summary.value = event.errors.map(({ id, message }) => ({ id, message }))
}

function onSubmit() {
  attempted.value = true
  summary.value = []
  confirmOpen.value = true
}

async function onConfirm() {
  const parsed = deleteAccountRequestSchema.safeParse(state)
  if (!parsed.success) {
    confirmOpen.value = false
    return
  }
  deleting.value = true
  status.value = 'Deleting your account…'
  try {
    await deleteAccount(parsed.data)
    useToast().add({ title: 'Your account was deleted.', icon: 'i-lucide-circle-check', color: 'success' })
  } catch (error) {
    status.value = ''
    const apiError = toUiApiError(error)
    if (apiError.status === 401) {
      confirmOpen.value = false
      await handleUnauthorized()
      return
    }
    const field: FormError[] =
      apiError.status === 403
        ? [{ name: 'password', message: apiError.message }]
        : apiError.issues.map((i) => ({ name: i.path, message: i.message }))
    pendingErrors = {
      field,
      summary: field.length
        ? field.map((e) => ({ message: e.message, id: e.name === 'password' ? PASSWORD_ID : undefined }))
        : [{ message: apiError.message }],
    }
    confirmOpen.value = false
  } finally {
    deleting.value = false
  }
}

/** Runs when the dialog closes. Shows pending errors and keeps focus off the trigger. */
function onCloseAutoFocus(event: Event) {
  if (!pendingErrors) return
  event.preventDefault()
  const { field, summary: items } = pendingErrors
  pendingErrors = null
  if (field?.length) form.value?.setErrors(field)
  summary.value = items
}
</script>

<template>
  <UContainer class="flex max-w-3xl flex-col gap-10 py-8 sm:py-12">
    <h1 tabindex="-1" class="text-3xl font-bold tracking-tight focus:outline-none">Account</h1>

    <section aria-labelledby="profile-heading" class="flex flex-col gap-4">
      <h2 id="profile-heading" class="text-xl font-semibold">Profile</h2>
      <p v-if="profileStatus === 'error'" role="alert" class="flex flex-wrap items-center gap-3">
        <span class="flex items-center gap-2">
          <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
          We couldn't load your profile.
        </span>
        <UButton
          color="neutral"
          variant="outline"
          label="Try again"
          class="min-h-11 min-w-11"
          @click="() => refresh()"
        />
      </p>
      <p v-else-if="!user" role="status" class="text-muted">Loading your profile…</p>
      <dl v-else class="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]" data-testid="profile">
        <dt class="font-medium">Email</dt>
        <dd class="break-all text-muted">{{ user.email }}</dd>
        <dt class="font-medium">Native language</dt>
        <dd class="text-muted">{{ languageNames.of(user.nativeLanguage) ?? user.nativeLanguage }}</dd>
        <dt class="font-medium">Time zone</dt>
        <dd class="text-muted">{{ user.timezone }}</dd>
        <dt class="font-medium">Daily limits</dt>
        <dd class="text-muted">
          {{ user.dailyNewLimit }} new words and {{ user.dailyReviewLimit }} reviews a day
        </dd>
        <dt class="font-medium">Member since</dt>
        <dd class="text-muted">{{ memberSince }}</dd>
      </dl>
    </section>

    <section aria-labelledby="logout-heading" class="flex flex-col gap-4">
      <h2 id="logout-heading" class="text-xl font-semibold">Log out</h2>
      <p class="text-muted">
        Logging out on all devices also ends sessions on other browsers, phones and computers.
      </p>
      <div class="flex flex-col gap-3 sm:flex-row">
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          :loading="logoutPending === 'current'"
          :disabled="logoutPending !== null"
          :label="logoutPending === 'current' ? 'Logging out…' : 'Log out'"
          class="min-h-11 min-w-11 justify-center"
          @click="onLogout('current')"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="lg"
          :loading="logoutPending === 'all'"
          :disabled="logoutPending !== null"
          :label="logoutPending === 'all' ? 'Logging out…' : 'Log out on all devices'"
          class="min-h-11 min-w-11 justify-center"
          @click="onLogout('all')"
        />
      </div>
      <p v-if="logoutError" role="alert" class="flex items-center gap-2 text-sm text-error">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" class="size-4 shrink-0" />
        <span>{{ logoutError }}</span>
      </p>
    </section>

    <section aria-labelledby="delete-heading" class="flex flex-col gap-4">
      <h2 id="delete-heading" class="text-xl font-semibold">Delete account</h2>
      <div class="flex flex-col gap-2">
        <p>
          This permanently deletes your account and everything in it: your collections, words, review schedule
          and history, and practice results.
        </p>
        <p class="font-medium">It can't be undone, and there is no way to recover the account afterwards.</p>
      </div>

      <AuthFormErrorSummary :errors="summary" />

      <UForm
        ref="form"
        :state="state"
        :validate="validate"
        :validate-on="attempted ? ['input', 'blur', 'change'] : []"
        :loading-auto="false"
        class="flex max-w-md flex-col gap-5"
        novalidate
        @submit="onSubmit"
        @error="onError"
      >
        <UFormField
          label="Current password"
          name="password"
          description="Enter your password to confirm it's you."
          size="xl"
        >
          <AuthPasswordInput :id="PASSWORD_ID" v-model="state.password" autocomplete="current-password" />
        </UFormField>
        <UButton
          type="submit"
          color="error"
          size="xl"
          label="Delete account…"
          class="min-h-12 min-w-11 justify-center sm:self-start"
        />
      </UForm>
      <p class="sr-only" role="status">{{ status }}</p>
    </section>

    <UModal
      v-model:open="confirmOpen"
      title="Delete your account permanently?"
      description="Your account and all your learning data will be deleted. This can't be undone."
      :dismissible="!deleting"
      :close="false"
      :content="{ onCloseAutoFocus }"
    >
      <template #footer>
        <div class="flex w-full flex-col gap-3 sm:flex-row sm:justify-end">
          <UButton
            color="neutral"
            variant="outline"
            size="lg"
            label="Cancel"
            :disabled="deleting"
            class="min-h-11 min-w-11 justify-center"
            @click="confirmOpen = false"
          />
          <UButton
            color="error"
            size="lg"
            :loading="deleting"
            :label="deleting ? 'Deleting…' : 'Delete my account'"
            class="min-h-11 min-w-11 justify-center"
            @click="onConfirm"
          />
        </div>
      </template>
    </UModal>
  </UContainer>
</template>
