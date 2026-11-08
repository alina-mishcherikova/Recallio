<script setup lang="ts">
// Error summary for auth forms (ADR 0002 §7; WCAG 3.3.1, 2.4.3). Shown after a failed submit, it
// takes focus, so screen readers announce it and keyboard users land on it. Each item links to its
// field. A new `errors` array (one per submit) moves focus here again.
export interface SummaryItem {
  message: string
  /** Id of the field to focus. Omitted for form-level errors (for example a 401 or 429). */
  id?: string
}

const props = withDefaults(defineProps<{ errors: SummaryItem[]; title?: string }>(), {
  title: 'There is a problem',
})

const root = useTemplateRef<HTMLElement>('root')
const headingId = useId()

async function focus() {
  await nextTick()
  root.value?.focus()
  root.value?.scrollIntoView({ block: 'nearest' })
}

watch(
  () => props.errors,
  (errors) => {
    if (errors.length) void focus()
  },
)

defineExpose({ focus })
</script>

<template>
  <div
    v-if="errors.length"
    ref="root"
    tabindex="-1"
    role="alert"
    :aria-labelledby="headingId"
    data-testid="form-error-summary"
    class="rounded-md focus:outline-2 focus:outline-offset-2 focus:outline-error"
  >
    <UAlert color="error" variant="subtle" icon="i-lucide-circle-alert">
      <template #title>
        <h2 :id="headingId" class="text-base font-semibold">{{ title }}</h2>
      </template>
      <template #description>
        <ul class="mt-1 list-disc space-y-1 ps-5 text-sm">
          <li v-for="(item, index) in errors" :key="`${index}-${item.id ?? ''}`">
            <a
              v-if="item.id"
              :href="`#${item.id}`"
              class="inline-flex min-h-11 min-w-11 items-center font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
              @click.prevent="focusById(item.id)"
              >{{ item.message }}</a
            >
            <span v-else>{{ item.message }}</span>
          </li>
        </ul>
        <slot />
      </template>
    </UAlert>
  </div>
</template>
