<script setup lang="ts">
/**
 * Tooltip — hover bubble around its trigger (default slot); the bubble
 * teleports to <body> with fixed positioning so overflow containers never
 * clip it. Shortcut keys render with Kbd. IconButton has its own tooltip
 * (useTooltip), so it is never wrapped in this.
 *
 * Props: label, shortcut?, side ('top' default | 'bottom' | 'right'),
 * delayMs (default 400), disabled?.
 */
import { ref } from 'vue'
import TooltipBubble from './TooltipBubble.vue'
import { useTooltip } from './useTooltip'

const props = withDefaults(
  defineProps<{
    label: string
    shortcut?: string
    side?: 'top' | 'bottom' | 'right'
    delayMs?: number
    disabled?: boolean
  }>(),
  { shortcut: '', side: 'top', delayMs: 400, disabled: false },
)

const anchor = ref<HTMLElement | null>(null)
const tooltip = useTooltip({
  anchor,
  side: () => props.side,
  delayMs: () => props.delayMs,
  enabled: () => !props.disabled && Boolean(props.label),
})
const { visible, position, listeners } = tooltip
</script>

<template>
  <span ref="anchor" class="ds-tooltip-anchor" v-on="listeners">
    <slot />
  </span>
  <TooltipBubble
    v-if="visible"
    :label="label"
    :shortcut="shortcut"
    :side="side"
    :position="position"
  />
</template>

<style scoped>
.ds-tooltip-anchor {
  display: inline-flex;
}
</style>
