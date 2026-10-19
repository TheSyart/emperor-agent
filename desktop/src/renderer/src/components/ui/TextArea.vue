<script setup lang="ts">
/**
 * TextArea — multi-line prose input with the TextField look (DS-04): r-sm,
 * a hairline on the field fill, 13/20, --focus-ring on focus, an error line
 * when invalid. Grows with its content between `minRows` and `maxRows`,
 * then scrolls. Picks up id / aria wiring from a surrounding <Field>.
 *
 * Props:
 * - modelValue (v-model): string.
 * - placeholder?, disabled?, readonly?, invalid?, id?.
 * - minRows (default 3), maxRows (default 10).
 * Other attributes land on the <textarea>; class / style on it too.
 */
import { computed } from 'vue'
import { useFieldControl } from './fieldContext'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    disabled?: boolean
    readonly?: boolean
    invalid?: boolean
    minRows?: number
    maxRows?: number
    id?: string
  }>(),
  {
    placeholder: undefined,
    disabled: false,
    readonly: false,
    invalid: false,
    minRows: 3,
    maxRows: 10,
    id: undefined,
  },
)

const model = defineModel<string>({ default: '' })
const control = useFieldControl(props, 'ds-textarea')

const rows = computed(() => {
  const lines = model.value ? model.value.split('\n').length : 1
  return Math.min(Math.max(lines, props.minRows), props.maxRows)
})
</script>

<template>
  <textarea
    :id="control.id.value"
    v-model="model"
    class="ds-text-area"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :aria-invalid="control.invalid.value || undefined"
    :aria-describedby="control.describedBy.value"
    :data-invalid="control.invalid.value || undefined"
  />
</template>

<style scoped>
.ds-text-area {
  display: block;
  width: 100%;
  min-width: 0;
  /* rows sizes the box; line-height + padding keep it exact */
  height: auto;
  padding: var(--space-1-5) var(--space-2-5);
  border: none;
  border-radius: var(--r-sm);
  outline: none;
  background: rgb(var(--field-fill));
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  resize: vertical;
  transition: box-shadow var(--motion-fast) var(--ease-standard);
}

.ds-text-area:focus {
  box-shadow:
    inset 0 0 0 0.5px var(--stroke-3),
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-text-area[data-invalid] {
  box-shadow: inset 0 0 0 1px rgb(var(--error));
}

.ds-text-area[data-invalid]:focus {
  box-shadow:
    inset 0 0 0 1px rgb(var(--error)),
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-text-area::placeholder {
  color: rgb(var(--text-4));
}

.ds-text-area:disabled {
  background: transparent;
  color: rgb(var(--text-3));
  cursor: default;
}
</style>
