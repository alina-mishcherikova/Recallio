<script setup lang="ts">
// Password field with a show/hide toggle (ADR 0002 §7). Use inside a UFormField: the label, the
// description and the error message are linked to the input by UFormField (aria-describedby).
// Paste and password managers always work (WCAG 3.3.8).
defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })
const props = defineProps<{
  /** Required: the toggle points at the input with `aria-controls`, and summary links use it. */
  id: string
  autocomplete: 'current-password' | 'new-password'
}>()

const visible = ref(false)
const announcement = ref('')

function toggle() {
  visible.value = !visible.value
  announcement.value = visible.value ? 'Your password is shown.' : 'Your password is hidden.'
}
</script>

<template>
  <UInput
    v-bind="$attrs"
    :id="props.id"
    v-model="model"
    :type="visible ? 'text' : 'password'"
    :autocomplete="props.autocomplete"
    autocapitalize="none"
    autocorrect="off"
    spellcheck="false"
    size="xl"
    class="w-full"
    :ui="{ base: 'min-h-12 pe-24', trailing: 'pe-0.5' }"
  >
    <template #trailing>
      <!-- The visible word is part of the accessible name (WCAG 2.5.3). -->
      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        :icon="visible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        :label="visible ? 'Hide' : 'Show'"
        :aria-label="visible ? 'Hide password' : 'Show password'"
        :aria-controls="props.id"
        class="min-h-11 min-w-11 justify-center"
        @click="toggle"
      />
    </template>
  </UInput>
  <span class="sr-only" role="status">{{ announcement }}</span>
</template>
