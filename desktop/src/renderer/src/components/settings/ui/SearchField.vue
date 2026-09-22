<script setup lang="ts">
/**
 * SearchField — dsh inventory search box: 36px, r8, l2 border on layer-1,
 * leading 16px search glyph (12px inset), 13/20 text, accent border + soft
 * ring on focus, and a clear button once there is text. Escape clears a
 * non-empty query (and is then stopped so it does not close the modal).
 *
 * Props:
 * - modelValue (v-model): the query.
 * - placeholder (default 「搜索」); also the accessible name unless
 *   `ariaLabel` is given.
 * - ariaLabel?, disabled?, id?.
 * - size: 'md' (36px, default) | 'sm' (30px).
 * Slots: `trailing` (a count / filter chip before the clear button).
 * Emits: update:modelValue, clear.
 * Exposes: focus().
 */
import { ref } from 'vue'
import { DsClose, DsSearch } from '../../icons/ds'
import { useFieldControl } from './fieldContext'

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
const control = useFieldControl(props, 'settings-search')
const input = ref<HTMLInputElement | null>(null)

function clear() {
  model.value = ''
  emit('clear')
  input.value?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !model.value) return
  event.preventDefault()
  event.stopPropagation()
  clear()
}

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div
    class="ds-search-field"
    :data-size="size"
    :data-disabled="disabled || undefined"
  >
    <DsSearch :size="14" class="glyph" />
    <input
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
      @keydown="onKeydown"
    />
    <span v-if="$slots.trailing" class="trailing"
      ><slot name="trailing"
    /></span>
    <button
      v-if="model && !disabled"
      type="button"
      class="clear"
      aria-label="清除搜索"
      title="清除"
      @click="clear"
    >
      <DsClose :size="12" />
    </button>
  </div>
</template>

<style scoped>
.ds-search-field {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: calc(var(--space-8) + var(--space-1));
  padding: 0 var(--space-1-5) 0 var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-tertiary));
  transition:
    border-color var(--duration-ds-fast) ease,
    box-shadow var(--duration-ds-fast) ease;
}

.ds-search-field[data-size='sm'] {
  height: calc(var(--space-7) + 2px);
}

.ds-search-field:focus-within {
  border-color: rgb(var(--accent-fill));
  box-shadow: 0 0 0 2px rgb(var(--accent-fill) / 0.18);
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
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
}

.input::placeholder {
  color: rgb(var(--label-tertiary));
}

.input::-webkit-search-cancel-button {
  appearance: none;
}

.trailing {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.clear {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--space-6);
  height: var(--space-6);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.clear:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.clear:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}
</style>
