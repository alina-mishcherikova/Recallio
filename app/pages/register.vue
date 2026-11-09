<script setup lang="ts">
import type { FormError, FormErrorEvent } from '@nuxt/ui'
import type { LanguageCode } from '#shared/constants/languages'
import { PASSWORD_MAX, PASSWORD_MIN, registerRequestSchema, timezoneSchema } from '#shared/schemas/auth'
import type { SummaryItem } from '~/components/auth/FormErrorSummary.vue'

definePageMeta({ auth: 'guest', layout: 'auth' })
useSeoMeta({ title: 'Create an account · Recallio' })

const FIELD_IDS = {
  email: 'register-email',
  password: 'register-password',
  nativeLanguage: 'register-native-language',
} as const

// Linked to the password field through UFormField's `description` (aria-describedby). The slot
// variant is not linked, so this must stay a prop.
const PASSWORD_REQUIREMENTS = `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters. A few unrelated words work well. Avoid your email address and simple patterns like 1234.`

const route = useRoute()
const { register } = useAuth()
const handoff = useEmailHandoff()

const state = reactive<{ email: string; password: string; nativeLanguage: LanguageCode | undefined }>({
  email: '',
  password: '',
  nativeLanguage: undefined,
})

// Detected on the device after hydration (the server can't know it). Sent only when the shared
// schema accepts it; otherwise the server uses its default (UTC).
const timezone = ref<string | undefined>()
onMounted(() => {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (timezoneSchema.safeParse(detected).success) timezone.value = detected
})

const form = useTemplateRef('form')
const summary = ref<SummaryItem[]>([])
const emailTaken = ref(false)
const status = ref('')
const attempted = ref(false)

const payload = () => ({ ...state, ...(timezone.value ? { timezone: timezone.value } : {}) })

function validate(): FormError[] {
  // The shared schema reports every field (including the password policy) in one pass, with fixed messages.
  return mergeFieldErrors(schemaFormErrors(registerRequestSchema, payload()))
}

function onError(event: FormErrorEvent) {
  attempted.value = true
  emailTaken.value = false
  summary.value = event.errors.map(({ id, message }) => ({ id, message }))
}

async function onSubmit() {
  attempted.value = true
  const parsed = registerRequestSchema.safeParse(payload())
  if (!parsed.success) return // `validate` already reported it
  summary.value = []
  emailTaken.value = false
  status.value = 'Creating your account…'
  try {
    await register(parsed.data)
    status.value = 'Account created.'
    await navigateTo(postAuthPath(route.query.redirect))
    await focusPageHeading()
  } catch (error) {
    status.value = ''
    const apiError = toUiApiError(error)
    if (apiError.issues.length) {
      const fieldErrors = mergeFieldErrors(apiError.issues.map((i) => ({ name: i.path, message: i.message })))
      form.value?.setErrors(fieldErrors)
      summary.value = fieldErrors.map((e) => ({
        message: e.message,
        id: FIELD_IDS[e.name as keyof typeof FIELD_IDS],
      }))
      return
    }
    emailTaken.value = apiError.status === 409
    summary.value = [{ message: apiError.message, id: emailTaken.value ? FIELD_IDS.email : undefined }]
  }
}

/** Carries the typed email to /login in memory (never in the URL). */
async function goToLogin() {
  handoff.value = state.email.trim()
  await navigateTo({ path: '/login', query: redirectQuery(route.query.redirect) })
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <h1 tabindex="-1" class="text-2xl font-bold tracking-tight focus:outline-none">Create an account</h1>
      <p class="text-sm text-muted">Start learning vocabulary with spaced repetition.</p>
    </div>

    <AuthFormErrorSummary :errors="summary">
      <p v-if="emailTaken" class="mt-2 text-sm">
        <ULink
          to="/login"
          class="inline-flex min-h-11 min-w-11 items-center font-medium text-error underline underline-offset-2"
          @click.prevent="goToLogin"
          >Log in with this email</ULink
        >
      </p>
    </AuthFormErrorSummary>

    <UForm
      ref="form"
      :state="state"
      :validate="validate"
      :validate-on="attempted ? ['input', 'blur', 'change'] : []"
      class="flex flex-col gap-5"
      novalidate
      @submit="onSubmit"
      @error="onError"
    >
      <template #default="{ loading }">
        <UFormField label="Email" name="email" size="xl">
          <UInput
            :id="FIELD_IDS.email"
            v-model="state.email"
            type="email"
            autocomplete="email"
            inputmode="email"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            size="xl"
            class="w-full"
            :ui="{ base: 'min-h-12' }"
          />
        </UFormField>

        <UFormField label="Password" name="password" :description="PASSWORD_REQUIREMENTS" size="xl">
          <AuthPasswordInput :id="FIELD_IDS.password" v-model="state.password" autocomplete="new-password" />
        </UFormField>

        <UFormField
          label="Native language"
          name="nativeLanguage"
          description="The language you already speak. Translations are shown in it."
          size="xl"
        >
          <FormNativeSelect
            :id="FIELD_IDS.nativeLanguage"
            v-model="state.nativeLanguage"
            :items="LANGUAGE_ITEMS"
            placeholder="Choose a language"
          />
        </UFormField>

        <p class="text-sm text-muted" data-testid="register-timezone">
          <template v-if="timezone">
            Time zone: <span class="font-medium text-default">{{ timezone }}</span> (from this device). It
            sets when your day starts for daily limits.
          </template>
          <template v-else>Time zone: UTC. It sets when your day starts for daily limits.</template>
        </p>

        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="No password recovery yet"
          description="If you forget your password, you can't get back into your account. A password manager can remember it for you."
        />

        <UButton
          type="submit"
          size="xl"
          block
          :loading="loading"
          :label="loading ? 'Creating your account…' : 'Create account'"
          class="min-h-12 min-w-11"
        />
        <p class="sr-only" role="status">{{ status }}</p>
      </template>
    </UForm>

    <p class="text-sm">
      Already have an account?
      <ULink
        :to="{ path: '/login', query: redirectQuery(route.query.redirect) }"
        class="inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-primary underline underline-offset-2"
        >Log in</ULink
      >
    </p>
  </div>
</template>
