<script setup lang="ts">
// Minimal app shell until full navigation lands (LEX-015): skip link, home link, and the two
// signed-in destinations.
const { loggedIn } = useUserSession()
useKeepFocusedFieldVisible()
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-default focus:px-4 focus:outline-2 focus:outline-primary"
    >
      Skip to main content
    </a>
    <header class="border-b border-default">
      <UContainer class="flex min-h-14 flex-wrap items-center justify-between gap-2 py-1">
        <NuxtLink
          to="/"
          class="inline-flex min-h-11 min-w-11 items-center rounded-md px-1 text-lg font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Recallio
        </NuxtLink>
        <nav v-if="loggedIn" aria-label="Main">
          <ul class="flex items-center gap-1">
            <li>
              <UButton
                to="/dashboard"
                variant="ghost"
                color="neutral"
                label="Dashboard"
                class="min-h-11 min-w-11"
              />
            </li>
            <li>
              <UButton
                to="/account"
                variant="ghost"
                color="neutral"
                label="Account"
                class="min-h-11 min-w-11"
              />
            </li>
          </ul>
        </nav>
      </UContainer>
    </header>
    <main id="main-content" tabindex="-1" class="flex-1 focus:outline-none">
      <slot />
    </main>
  </div>
</template>
