<script setup lang="ts">
// One collection in the list. The title is the link (one tab stop per card); everything else is
// plain text. Status is text + icon, never color alone.
import type { Collection } from '#shared/schemas/collections'
import LanguagePair from '~/components/collections/LanguagePair.vue'

const props = defineProps<{ collection: Collection }>()

const words = computed(() =>
  props.collection.entryCount === 1 ? '1 word' : `${props.collection.entryCount} words`,
)
</script>

<template>
  <UCard :ui="{ body: 'flex flex-col gap-2 p-4 sm:p-5' }" data-testid="collection-card">
    <h2 class="text-lg font-semibold break-words">
      <NuxtLink
        :id="`collection-link-${collection.id}`"
        :to="collectionPath(collection.id)"
        class="inline-flex min-h-11 min-w-11 items-center rounded-sm text-highlighted underline-offset-4 hover:underline focus-visible:underline"
      >
        {{ collection.title }}
      </NuxtLink>
    </h2>
    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <LanguagePair
        :native-language="collection.nativeLanguage"
        :target-language="collection.targetLanguage"
        class="font-medium text-default"
      />
      <span v-if="collection.topic" class="break-words">Topic: {{ collection.topic }}</span>
      <span>{{ words }}</span>
      <UBadge
        v-if="collection.archivedAt"
        color="neutral"
        variant="subtle"
        icon="i-lucide-archive"
        label="Archived"
      />
    </p>
  </UCard>
</template>
