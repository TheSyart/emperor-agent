<script setup lang="ts">
/**
 * TextArea — multi-line prose input with the TextField look (l2 border on
 * layer-3, r8, 13/20, accent focus border, error border when invalid).
 * Grows with its content between `minRows` and `maxRows`, then scrolls.
 * Picks up id / aria wiring from a surrounding <Field>.
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
const control = useFieldControl(props, 'settings-textarea')

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
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  outline: none;
  background: rgb(var(--bg-layer-3));
  box-shadow: none;
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
  resize: vertical;
  transition: border-color var(--duration-ds-fast) ease;
}

.ds-text-area:focus {
  border-color: rgb(var(--accent-fill));
  box-shadow: none;
}

.ds-text-area[data-invalid] {
  border-color: rgb(var(--state-error));
}

.ds-text-area::placeholder {
  color: rgb(var(--label-caption));
}

.ds-text-area:disabled {
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: default;
}
</style>
