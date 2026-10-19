<script setup lang="ts" generic="T extends string | number">
/**
 * Segmented — a choice between a few values (DS-04): the segmented Tabs
 * look (a sunken track, the chosen segment raised, 28px; md 32px) as a
 * radio group with roving tabindex: ArrowLeft / ArrowRight / Home / End
 * move and select. Use Tabs variant="segmented" for view filters.
 *
 * Props:
 * - modelValue (v-model): selected value.
 * - options: SegmentedOption[] ({ value, label, icon?, disabled? }).
 * - size: 'sm' (28px, default) | 'md' (32px).
 * - block?: stretch to the container, equal-width segments.
 * - ariaLabel?: radiogroup name.
 * Emits: update:modelValue, change(value).
 */
import { computed } from 'vue'
import Tabs from './Tabs.vue'
import type { SegmentedOption } from './inputTypes'

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

const tabs = computed(() =>
  props.options.map((option) => ({
    id: String(option.value),
    label: option.label,
    icon: option.icon,
    disabled: option.disabled,
  })),
)

function pick(id: string) {
  const option = props.options.find((item) => String(item.value) === id)
  if (!option || option.disabled || option.value === model.value) return
  model.value = option.value
  emit('change', option.value)
}
</script>

<template>
  <Tabs
    variant="segmented"
    semantics="radio"
    :tabs="tabs"
    :model-value="model === undefined ? '' : String(model)"
    :size="size === 'md' ? 'large' : 'default'"
    :block="block"
    :aria-label="ariaLabel"
    @update:model-value="pick"
  />
</template>
