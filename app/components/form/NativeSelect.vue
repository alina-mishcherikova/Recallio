<script setup lang="ts" generic="T extends string">
// A native <select>, wired into UForm/UFormField with Nuxt UI's `useFormField` (label, error,
// description, aria-invalid, aria-describedby, validation events).
// Why not USelect: its Reka internals render inline `style` attributes (the placeholder span and a
// hidden native select), which the nonce-only CSP blocks. A native select also gives mobile users
// the platform picker, and works before hydration.
const model = defineModel<T | undefined>()
const props = defineProps<{
  id: string
  items: readonly { label: string; value: T }[]
  placeholder?: string
  disabled?: boolean
}>()

const { id, name, disabled, ariaAttrs, emitFormBlur, emitFormFocus, emitFormChange, emitFormInput } =
  useFormField(props)

function onChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  model.value = (props.items.find((item) => item.value === value)?.value ?? undefined) as T | undefined
  emitFormChange()
  void emitFormInput()
}
</script>

<template>
  <div class="relative w-full">
    <select
      :id="id"
      :name="name"
      :disabled="disabled"
      v-bind="ariaAttrs"
      class="min-h-12 w-full appearance-none rounded-md bg-default py-2 ps-3 pe-10 text-base text-highlighted ring ring-inset ring-accented focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-75 aria-invalid:ring-error"
      @change="onChange"
      @blur="emitFormBlur"
      @focus="emitFormFocus"
    >
      <option v-if="placeholder" value="" disabled :selected="model === undefined">{{ placeholder }}</option>
      <option v-for="item in items" :key="item.value" :value="item.value" :selected="item.value === model">
        {{ item.label }}
      </option>
    </select>
    <UIcon
      name="i-lucide-chevron-down"
      class="pointer-events-none absolute end-3 top-1/2 size-5 -translate-y-1/2 text-muted"
    />
  </div>
</template>
