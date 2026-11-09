<script setup lang="ts">
// The collection's direction as text, native → target ("English → French"). Screen readers get
// "English to French" instead of "right arrow".
const props = defineProps<{ nativeLanguage: string; targetLanguage: string }>()
const visible = computed(() => languagePairLabel(props))
const spoken = computed(() => languagePairSpoken(props))
</script>

<template>
  <span data-testid="language-pair">
    <span aria-hidden="true">{{ visible }}</span>
    <span class="sr-only">{{ spoken }}</span>
  </span>
</template>
