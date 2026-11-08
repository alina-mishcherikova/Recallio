<script setup lang="ts">
// `interactive-widget=resizes-content`: on Android Chrome the on-screen keyboard resizes the layout
// viewport, so `dvh` layouts shrink with it and the focused field stays visible (US-UI-01).
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1, interactive-widget=resizes-content' },
  ],
})
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
