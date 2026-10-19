<script setup lang="ts">
/**
 * Checkbox — a 16px box with an optional label (DS-04): unchecked,
 * checked or indeterminate (a dash; for "some of these"). A native
 * checkbox underneath keeps Space, labels, forms and screen readers
 * working; picking an indeterminate box checks it and clears the mixed
 * state. Focus draws --focus-ring. Picks up id / aria wiring from <Field>.
 *
 * Props:
 * - modelValue (v-model): boolean.
 * - indeterminate (v-model:indeterminate): the mixed state.
 * - label? (or the default slot), disabled?, id?, ariaLabel?.
 * Emits: update:modelValue, update:indeterminate, change(value).
 */
import { computed } from 'vue'
import Icon from './Icon.vue'
import { useFieldControl } from './fieldContext'

const props = withDefaults(
  defineProps<{
    label?: string
    disabled?: boolean
    id?: string
    ariaLabel?: string
  }>(),
  { label: undefined, disabled: false, id: undefined, ariaLabel: undefined },
)

const model = defineModel<boolean>({ default: false })
const indeterminate = defineModel<boolean>('indeterminate', { default: false })
const emit = defineEmits<{ change: [value: boolean] }>()
const control = useFieldControl(props, 'ds-checkbox')

const state = computed(() =>
  indeterminate.value ? 'mixed' : model.value ? 'checked' : 'unchecked',
)

function onChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (props.disabled) {
    input.checked = model.value
    return
  }
  indeterminate.value = false
  model.value = input.checked
  emit('change', input.checked)
}
</script>

<template>
  <label
    class="ds-checkbox"
    :data-state="state"
    :data-disabled="disabled || undefined"
  >
    <input
      :id="control.id.value"
      class="native"
      type="checkbox"
      :checked="model"
      :indeterminate="indeterminate"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-describedby="control.describedBy.value"
      @change="onChange"
    />
    <span class="box" aria-hidden="true">
      <Icon v-if="state === 'checked'" name="check" size="xs" />
      <Icon v-else-if="state === 'mixed'" name="minus" size="xs" />
    </span>
    <span v-if="$slots.default || label" class="label"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>

<style scoped>
.ds-checkbox {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  cursor: pointer;
}

.ds-checkbox[data-disabled] {
  color: rgb(var(--text-disabled));
  cursor: default;
}

.native {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}

.box {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--icon-md);
  height: var(--icon-md);
  border-radius: var(--r-xs);
  background: rgb(var(--field-fill));
  box-shadow: inset 0 0 0 1px var(--stroke-4);
  color: rgb(var(--surface-base));
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard);
}

.ds-checkbox:hover:not([data-disabled]) .box {
  box-shadow: inset 0 0 0 1px rgb(var(--text-3));
}

.ds-checkbox:is([data-state='checked'], [data-state='mixed']) .box {
  background: rgb(var(--text-1));
  box-shadow: none;
}

.ds-checkbox[data-disabled] .box {
  opacity: 0.5;
}

.native:focus-visible + .box {
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.label {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
