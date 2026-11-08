<script setup lang="ts">
definePageMeta({ auth: 'public' })

useSeoMeta({
  title: 'Recallio',
  description: 'Learn vocabulary, remember it for longer.',
})

const { loggedIn } = useUserSession()
</script>

<template>
  <UContainer class="flex flex-col items-center justify-center gap-6 py-12 text-center sm:py-20">
    <h1 tabindex="-1" class="text-4xl font-bold tracking-tight focus:outline-none">Recallio</h1>
    <p class="max-w-prose text-lg text-muted">
      Learn vocabulary in different ways, remember it for longer, and use it independently.
    </p>
    <div class="flex w-full max-w-xs flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">
      <template v-if="loggedIn">
        <UButton
          to="/dashboard"
          size="xl"
          label="Go to your dashboard"
          class="min-h-11 min-w-11 justify-center"
        />
      </template>
      <template v-else>
        <UButton to="/register" size="xl" label="Create account" class="min-h-11 min-w-11 justify-center" />
        <UButton
          to="/login"
          size="xl"
          color="neutral"
          variant="outline"
          label="Log in"
          class="min-h-11 min-w-11 justify-center"
        />
      </template>
    </div>
  </UContainer>
</template>
