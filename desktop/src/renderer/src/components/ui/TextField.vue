<script setup lang="ts">
/**
 * TextField — a single-line input (DS-04): 32px (sm 28), r-sm, a hairline
 * on the field fill, 13/20 text; focus draws --focus-ring, invalid an
 * error line. Picks up id / aria wiring from a surrounding <Field>.
 *
 * Props:
 * - modelValue (v-model): string.
 * - type: 'text' (default) | 'password' | 'url' | 'number' | 'email' |
 *   'datetime-local'.
 * - placeholder?, disabled?, readonly?, invalid?, id?.
 * - monospace?: code font (paths, ids, URLs).
 * - size: 'md' (32px, default) | 'sm' (28px, dense rows).
 * Slots: `leading` / `trailing` (16px glyphs or tiny buttons in the box).
 * Other attributes (name, autocomplete, inputmode, aria-label, listeners
 * such as @keydown.enter / @blur) land on the <input>; class / style on the
 * box. Exposes focus(), select() and the input element.
 */
import { computed, ref, useAttrs } from 'vue'
import { useFieldControl } from './fieldContext'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    type?: 'text' | 'password' | 'url' | 'number' | 'email' | 'datetime-local'
    placeholder?: string
    disabled?: boolean
    readonly?: boolean
    invalid?: boolean
    monospace?: boolean
    size?: 'md' | 'sm'
    id?: string
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    disabled: false,
    readonly: false,
    invalid: false,
    monospace: false,
    size: 'md',
    id: undefined,
  },
)

const model = defineModel<string>({ default: '' })
const attrs = useAttrs()
const control = useFieldControl(props, 'ds-text')
const input = ref<HTMLInputElement | null>(null)

const boxAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs }
  delete rest.class
  delete rest.style
  return rest
})

defineExpose({
  focus: () => input.value?.focus(),
  select: () => input.value?.select(),
  input,
})
</script>

<template>
  <span
    class="ds-text-field"
    v-bind="boxAttrs"
    :data-size="size"
    :data-invalid="control.invalid.value || undefined"
    :data-disabled="disabled || undefined"
  >
    <span v-if="$slots.leading" class="adorn"><slot name="leading" /></span>
    <input
      v-bind="inputAttrs"
      :id="control.id.value"
      ref="input"
      v-model="model"
      class="input"
      :class="{ mono: monospace }"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :aria-invalid="control.invalid.value || undefined"
      :aria-describedby="control.describedBy.value"
    />
    <span v-if="$slots.trailing" class="adorn"><slot name="trailing" /></span>
  </span>
</template>

<style scoped>
.ds-text-field {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  min-width: 0;
  height: var(--field-h);
  padding: 0 var(--space-2-5);
  border-radius: var(--r-sm);
  background: rgb(var(--field-fill));
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  transition: box-shadow var(--motion-fast) var(--ease-standard);
}

.ds-text-field[data-size='sm'] {
  height: var(--field-h-sm);
  padding: 0 var(--space-2);
}

.ds-text-field:focus-within {
  box-shadow:
    inset 0 0 0 0.5px var(--stroke-3),
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-text-field[data-invalid] {
  box-shadow: inset 0 0 0 1px rgb(var(--error));
}

.ds-text-field[data-invalid]:focus-within {
  box-shadow:
    inset 0 0 0 1px rgb(var(--error)),
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-text-field[data-disabled] {
  background: transparent;
  cursor: default;
}

.input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  outline: none;
  background: transparent;
  box-shadow: none;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.input.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}

.input::placeholder {
  color: rgb(var(--text-4));
}

.input:disabled {
  color: rgb(var(--text-3));
  cursor: default;
}

.adorn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--text-3));
}
</style>
