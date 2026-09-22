<script setup lang="ts">
/**
 * TextField — single-line settings input (dsh fields: 34px, r8, l2 border
 * on layer-3, 13/20; focus = accent border; invalid = error border).
 * Picks up id / aria wiring from a surrounding <Field>.
 *
 * Props:
 * - modelValue (v-model): string.
 * - type: 'text' (default) | 'password' | 'url' | 'number' | 'email'.
 * - placeholder?, disabled?, readonly?, invalid?, id?.
 * - monospace?: code font (paths, ids, URLs).
 * - size: 'md' (34px, default) | 'sm' (28px, dense rows).
 * Slots: `leading` / `trailing` (16px glyphs or tiny buttons inside the box).
 * Other attributes (name, autocomplete, inputmode, aria-label, listeners such
 * as @keydown.enter / @blur) land on the <input>; class / style on the box.
 */
import { computed, useAttrs } from 'vue'
import { useFieldControl } from './fieldContext'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    type?: 'text' | 'password' | 'url' | 'number' | 'email'
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
const control = useFieldControl(props, 'settings-text')

const boxAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs }
  delete rest.class
  delete rest.style
  return rest
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
  height: calc(var(--space-8) + 2px);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-3));
  transition: border-color var(--duration-ds-fast) ease;
}

.ds-text-field[data-size='sm'] {
  height: var(--space-7);
  padding: 0 var(--space-2-5);
}

.ds-text-field:focus-within {
  border-color: rgb(var(--accent-fill));
}

.ds-text-field[data-invalid] {
  border-color: rgb(var(--state-error));
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
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
}

.input.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}

.input::placeholder {
  color: rgb(var(--label-caption));
}

.input:disabled {
  color: rgb(var(--label-tertiary));
  cursor: default;
}

.adorn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--label-tertiary));
}
</style>
