<script setup lang="ts" generic="T extends string | number">
/**
 * Segmented — dsh segmented control (token-usage range / view switch): an
 * l2-bordered r8 strip on the base fill, 28px segments split by l1
 * hairlines, 12/18 secondary labels; the selected segment takes the Emperor
 * gold fill. A radiogroup with roving tabindex: ArrowLeft / ArrowRight /
 * Home / End move and select.
 *
 * Props:
 * - modelValue (v-model): selected value.
 * - options: SegmentedOption[] ({ value, label, icon?, disabled? }).
 * - size: 'sm' (28px, default) | 'md' (32px).
 * - block?: stretch to the container, equal-width segments.
 * - ariaLabel?: radiogroup name.
 * Emits: update:modelValue, change(value).
 */
import type { SegmentedOption } from './types'

const props = withDefaults(
  defineProps<{
    options: readonly SegmentedOption<T>[]
    size?: 'sm' | 'md'
    block?: boolean
    ariaLabel?: string
  }>(),
  { size: 'sm', block: false, ariaLabel: undefined },
)

const model = defineModel<T>()
const emit = defineEmits<{ change: [value: T] }>()

function select(option: SegmentedOption<T>) {
  if (option.disabled || option.value === model.value) return
  model.value = option.value
  emit('change', option.value)
}

function focusable(option: SegmentedOption<T>, index: number) {
  const selected = props.options.some((item) => item.value === model.value)
  if (selected) return option.value === model.value
  return index === props.options.findIndex((item) => !item.disabled)
}

function onKeydown(event: KeyboardEvent, index: number) {
  const enabled = props.options.filter((option) => !option.disabled)
  const at = enabled.indexOf(props.options[index])
  let next: SegmentedOption<T> | undefined
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
    next = enabled[(at + 1) % enabled.length]
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    next = enabled[(at - 1 + enabled.length) % enabled.length]
  else if (event.key === 'Home') next = enabled[0]
  else if (event.key === 'End') next = enabled[enabled.length - 1]
  if (!next) return
  event.preventDefault()
  select(next)
  const group = (event.currentTarget as HTMLElement).parentElement
  const target = [
    ...(group?.querySelectorAll<HTMLElement>('[data-segment]') ?? []),
  ].find((el) => el.dataset.segment === String(next.value))
  target?.focus()
}
</script>

<template>
  <div
    class="ds-segmented"
    role="radiogroup"
    :aria-label="ariaLabel"
    :data-size="size"
    :data-block="block || undefined"
  >
    <button
      v-for="(option, index) in options"
      :key="String(option.value)"
      type="button"
      role="radio"
      class="segment"
      :data-segment="String(option.value)"
      :aria-checked="option.value === model"
      :tabindex="focusable(option, index) ? 0 : -1"
      :disabled="option.disabled"
      @click="select(option)"
      @keydown="onKeydown($event, index)"
    >
      <component :is="option.icon" v-if="option.icon" :size="14" />
      <span class="label">{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.ds-segmented {
  display: inline-flex;
  flex: none;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-base));
}

.ds-segmented[data-block] {
  display: flex;
  width: 100%;
}

.segment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-width: 0;
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  border: none;
  border-right: 1px solid var(--border-l1);
  background: transparent;
  font: inherit;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-secondary));
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    color var(--duration-ds-fast) ease;
}

.ds-segmented[data-size='md'] .segment {
  height: var(--space-8);
  padding: 0 var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.ds-segmented[data-block] .segment {
  flex: 1 1 0;
}

.segment:last-child {
  border-right: none;
}

.segment:hover:not(:disabled):not([aria-checked='true']) {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.segment[aria-checked='true'] {
  background: rgb(var(--accent-fill));
  color: rgb(var(--accent-fg));
}

.segment:focus-visible {
  position: relative;
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.segment:disabled {
  color: rgb(var(--label-dimmed));
  cursor: default;
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
