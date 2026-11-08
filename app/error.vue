<script setup lang="ts">
// Error page (ADR 0002 §6.7). Shows only the status code and a fixed message: never `error.message`,
// `error.url` or anything else that could come from the request.
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const statusCode = computed(() => {
  const code = Number(props.error?.statusCode)
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500
})

const MESSAGES: Record<number, { title: string; text: string }> = {
  404: { title: 'Page not found', text: "We couldn't find this page. Check the address, or go back home." },
  403: { title: 'Access denied', text: "You don't have access to this page." },
  401: { title: 'Please log in', text: 'Log in to see this page.' },
}
const content = computed(
  () =>
    MESSAGES[statusCode.value] ?? { title: 'Something went wrong', text: 'Please try again in a moment.' },
)

useSeoMeta({ title: () => `${content.value.title} · Recallio` })

function goHome() {
  void clearError({ redirect: '/' })
}
</script>

<template>
  <UApp>
    <main id="main-content" class="flex min-h-dvh items-center justify-center px-4 py-12">
      <div class="flex max-w-md flex-col items-center gap-4 text-center">
        <p class="text-sm font-medium text-muted">Error {{ statusCode }}</p>
        <h1 class="text-3xl font-bold tracking-tight">{{ content.title }}</h1>
        <p class="text-muted">{{ content.text }}</p>
        <UButton size="xl" label="Go to the home page" class="min-h-11 min-w-11" @click="goHome" />
      </div>
    </main>
  </UApp>
</template>
