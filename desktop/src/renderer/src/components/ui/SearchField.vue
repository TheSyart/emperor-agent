<script setup lang="ts">
/**
 * SearchField — the one search box (DS-04): 32px (sm 28), r-sm, a hairline
 * on the field fill, a leading search glyph, 13/20 text, --focus-ring on
 * focus, and a clear button once there is text. Escape clears a non-empty
 * query and stops there (so it does not close the surrounding popover or
 * dialog); on an empty box Escape goes through to the owner.
 *
 * Props:
 * - modelValue (v-model): the query.
 * - placeholder (default 「搜索」); also the accessible name unless
 *   `ariaLabel` is given.
 * - ariaLabel?, disabled?, id?.
 * - size: 'md' (32px, default) | 'sm' (28px).
 * Slots: `trailing` (a count / filter chip before the clear button).
 * Other attributes and listeners (@keydown, @blur, @input, data-*) land on
 * the <input>; class / style on the box.
 * Emits: update:modelValue, clear.
 * Exposes: focus(), blur(), select() and the input element.
 */
import { computed, ref, useAttrs } from 'vue'
import IconButton from './IconButton.vue'
import Icon from './Icon.vue'
import { useFieldControl } from './fieldContext'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    placeholder?: string
    ariaLabel?: string
    disabled?: boolean
    id?: string
    size?: 'md' | 'sm'
  }>(),
  {
    placeholder: '搜索',
    ariaLabel: undefined,
    disabled: false,
    id: undefined,
    size: 'md',
  },
)

const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ clear: [] }>()
const attrs = useAttrs()
const control = useFieldControl(props, 'ds-search')
const input = ref<HTMLInputElement | null>(null)

const boxAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs }
  delete rest.class
  delete rest.style
  return rest
})

function clear() {
  model.value = ''
  emit('clear')
  input.value?.focus()
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !model.value) return
  event.preventDefault()
  event.stopPropagation()
  clear()
}

defineExpose({
  focus: () => input.value?.focus(),
  blur: () => input.value?.blur(),
  select: () => input.value?.select(),
  input,
})
</script>

<template>
  <div
    class="ds-search-field"
    v-bind="boxAttrs"
    :data-size="size"
    :data-disabled="disabled || undefined"
    :data-filled="model ? true : undefined"
  >
    <Icon name="search" size="sm" class="glyph" />
    <input
      v-bind="inputAttrs"
      :id="control.id.value"
      ref="input"
      v-model="model"
      class="input"
      type="search"
      :placeholder="placeholder"
      :aria-label="ariaLabel ?? placeholder"
      :aria-describedby="control.describedBy.value"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      @keydown="onEscape"
    />
    <span v-if="$slots.trailing" class="trailing"
      ><slot name="trailing"
    /></span>
    <IconButton
      v-if="model && !disabled"
      class="clear"
      size="xs"
      shape="circle"
      label="清除搜索"
      :tooltip="false"
      @click="clear"
    >
      <Icon name="close" size="xs" />
    </IconButton>
  </div>
</template>

<style scoped>
.ds-search-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: var(--field-h);
  padding: 0 var(--space-1-5) 0 var(--space-2-5);
  border-radius: var(--r-sm);
  background: rgb(var(--field-fill));
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
  color: rgb(var(--text-3));
  transition: box-shadow var(--motion-fast) var(--ease-standard);
}

.ds-search-field[data-size='sm'] {
  height: var(--field-h-sm);
  padding-left: var(--space-2);
}

.ds-search-field:focus-within {
  box-shadow:
    inset 0 0 0 0.5px var(--stroke-3),
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-search-field[data-disabled] {
  opacity: 0.6;
}

.glyph {
  flex: none;
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

.input::placeholder {
  color: rgb(var(--text-4));
}

.input::-webkit-search-cancel-button {
  appearance: none;
}

.trailing {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.clear {
  flex: none;
}
</style>
