<script setup lang="ts">
import type { FormError, FormErrorEvent } from '@nuxt/ui'
import { loginRequestSchema } from '#shared/schemas/auth'
import type { SummaryItem } from '~/components/auth/FormErrorSummary.vue'

definePageMeta({ auth: 'guest', layout: 'auth' })
useSeoMeta({ title: 'Log in · Recallio' })

const FIELD_IDS = { email: 'login-email', password: 'login-password' } as const

const route = useRoute()
const { login } = useAuth()

const handoff = useEmailHandoff()
const state = reactive({ email: handoff.value ?? '', password: '' })
handoff.value = null

const form = useTemplateRef('form')
const summary = ref<SummaryItem[]>([])
const status = ref('')
// Fields are validated on submit; after the first attempt, errors update as the user fixes them.
const attempted = ref(false)

const validate = (s: typeof state): FormError[] => mergeFieldErrors(schemaFormErrors(loginRequestSchema, s))

function onError(event: FormErrorEvent) {
  attempted.value = true
  summary.value = event.errors.map(({ id, message }) => ({ id, message }))
}

async function onSubmit() {
  attempted.value = true
  const parsed = loginRequestSchema.safeParse(state)
  if (!parsed.success) return // `validate` already reported it
  summary.value = []
  status.value = 'Logging in…'
  try {
    await login(parsed.data)
    status.value = 'Logged in.'
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
    // 401: one generic message for an unknown email and a wrong password. The link goes to the
    // first field so keyboard users can correct it.
    summary.value = [{ message: apiError.message, id: apiError.status === 401 ? FIELD_IDS.email : undefined }]
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <h1 tabindex="-1" class="text-2xl font-bold tracking-tight focus:outline-none">Log in</h1>
      <p class="text-sm text-muted">Welcome back. Log in to continue learning.</p>
    </div>

    <AuthFormErrorSummary :errors="summary" />

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

        <UFormField label="Password" name="password" size="xl">
          <AuthPasswordInput
            :id="FIELD_IDS.password"
            v-model="state.password"
            autocomplete="current-password"
          />
        </UFormField>

        <UButton
          type="submit"
          size="xl"
          block
          :loading="loading"
          :label="loading ? 'Logging in…' : 'Log in'"
          class="min-h-12 min-w-11"
        />
        <p class="sr-only" role="status">{{ status }}</p>
      </template>
    </UForm>

    <div class="flex flex-col gap-2 text-sm">
      <p>
        New to Recallio?
        <ULink
          :to="{ path: '/register', query: redirectQuery(route.query.redirect) }"
          class="inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-primary underline underline-offset-2"
          >Create an account</ULink
        >
      </p>
      <p class="text-muted">
        Password recovery isn't available yet. A password manager can remember it for you.
      </p>
    </div>
  </div>
</template>
