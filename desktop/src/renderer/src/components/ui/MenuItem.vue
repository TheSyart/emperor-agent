<script setup lang="ts">
/**
 * MenuItem — one dsh menu row (40px, 14/22, radius 10, hover fill).
 *
 * Props:
 * - variant: 'item' (default) | 'label' (12/16 tertiary heading) |
 *   'separator' (l1 hairline).
 * - selected?: trailing check mark.
 * - danger?: error color + danger hover.
 * - disabled?.
 * - description?: 12/18 secondary line under the label.
 * - keepOpen?: do not close the parent Menu on click.
 * Slots: `icon` (16px leading glyph), default (label), `trailing`.
 * Emits: select.
 */
import { inject } from 'vue'
import { DsCheck } from '../icons/ds'
import { MENU_CONTEXT } from './menuContext'

const props = withDefaults(
  defineProps<{
    variant?: 'item' | 'label' | 'separator'
    selected?: boolean
    danger?: boolean
    disabled?: boolean
    description?: string
    keepOpen?: boolean
  }>(),
  {
    variant: 'item',
    selected: false,
    danger: false,
    disabled: false,
    description: undefined,
    keepOpen: false,
  },
)

const emit = defineEmits<{ select: [] }>()
const menu = inject(MENU_CONTEXT, null)

function activate() {
  if (props.disabled) return
  emit('select')
  if (!props.keepOpen) menu?.close()
}
</script>

<template>
  <div v-if="variant === 'separator'" class="separator" role="separator" />
  <div v-else-if="variant === 'label'" class="label"><slot /></div>
  <button
    v-else
    type="button"
    role="menuitem"
    class="item"
    :data-dense="menu?.dense || undefined"
    :data-danger="danger || undefined"
    :aria-checked="selected || undefined"
    :disabled="disabled"
    @click="activate"
  >
    <span v-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <span class="text">
      <span class="item-label"><slot /></span>
      <span v-if="description" class="description">{{ description }}</span>
    </span>
    <slot name="trailing" />
    <DsCheck v-if="selected" :size="16" class="check" />
  </button>
</template>

<style scoped>
.item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: calc(var(--space-8) + var(--space-2));
  padding: var(--space-2) var(--space-2-5);
  border: none;
  border-radius: var(--radius-cell);
  background: transparent;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}

.item[data-dense] {
  min-height: calc(var(--space-8) + 2px);
  padding-block: var(--space-1);
}

.item:hover:not(:disabled),
.item:focus-visible {
  outline: none;
  background: var(--interactive-bg-hover);
}

.item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.item[data-danger],
.item[data-danger] .icon {
  color: rgb(var(--danger));
}

.item[data-danger]:hover:not(:disabled) {
  background: var(--interactive-bg-hover-danger);
}

.icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  color: rgb(var(--label-tertiary));
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.check {
  flex: none;
  color: rgb(var(--label-primary));
}

.label {
  padding: var(--space-2) var(--space-2-5);
  font-size: var(--fs-xxs);
  line-height: var(--space-4);
  color: rgb(var(--label-tertiary));
}

.separator {
  height: 1px;
  margin: var(--space-1) 2px;
  background: var(--border-l1);
}
</style>
