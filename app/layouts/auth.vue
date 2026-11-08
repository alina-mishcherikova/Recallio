<script setup lang="ts">
// One-column layout for /login and /register (ADR 0002 §7). Top-aligned on small screens so the
// form doesn't jump when the keyboard opens; centered from `sm` up.
useKeepFocusedFieldVisible()
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="flex justify-center px-4 pt-4 sm:pt-8">
      <NuxtLink
        to="/"
        class="inline-flex min-h-11 min-w-11 items-center rounded-md px-2 text-xl font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        Recallio
      </NuxtLink>
    </header>
    <main id="main-content" class="flex flex-1 justify-center px-4 pt-4 pb-12 sm:items-center sm:pt-6">
      <UCard class="w-full max-w-md" :ui="{ body: 'p-4 sm:p-6' }">
        <slot />
      </UCard>
    </main>
  </div>
</template>
