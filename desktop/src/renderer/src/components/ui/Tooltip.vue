<script setup lang="ts">
/**
 * Tooltip — dsh hover bubble (13/20 on tooltip-bg, radius 8, fade-in).
 * Wraps its trigger (default slot); the bubble teleports to <body> with
 * fixed positioning so overflow containers never clip it.
 *
 * Props:
 * - label: bubble text (pre-line).
 * - side: 'top' (default) | 'bottom' | 'right'.
 * - delayMs (default 400).
 * - disabled?.
 */
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    side?: 'top' | 'bottom' | 'right'
    delayMs?: number
    disabled?: boolean
  }>(),
  { side: 'top', delayMs: 400, disabled: false },
)

const GAP = 6
const anchor = ref<HTMLElement | null>(null)
const visible = ref(false)
const position = ref({ left: '0px', top: '0px' })
let timer: ReturnType<typeof setTimeout> | undefined

function place() {
  const rect = anchor.value?.getBoundingClientRect()
  if (!rect) return
  if (props.side === 'right')
    position.value = {
      left: `${rect.right + GAP}px`,
      top: `${rect.top + rect.height / 2}px`,
    }
  else
    position.value = {
      left: `${rect.left + rect.width / 2}px`,
      top: `${props.side === 'top' ? rect.top - GAP : rect.bottom + GAP}px`,
    }
}

function show() {
  if (props.disabled || !props.label) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    place()
    visible.value = true
  }, props.delayMs)
}

function hide() {
  clearTimeout(timer)
  visible.value = false
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <span
    ref="anchor"
    class="ds-tooltip-anchor"
    @pointerenter="show"
    @pointerleave="hide"
    @focusin="show"
    @focusout="hide"
    @pointerdown="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="visible"
      class="ds-tooltip ds-fade-in"
      role="tooltip"
      :data-side="side"
      :style="position"
    >
      {{ label }}
    </div>
  </Teleport>
</template>

<style scoped>
.ds-tooltip-anchor {
  display: inline-flex;
}

.ds-tooltip {
  position: fixed;
  z-index: var(--z-lightbox);
  width: max-content;
  max-width: 50vw;
  padding: calc(var(--space-1) - 1px) calc(var(--space-2) - 1px);
  border-radius: var(--radius-row);
  background: rgb(var(--tooltip-bg));
  color: rgb(var(--tooltip-fg));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
}

.ds-tooltip[data-side='top'] {
  transform: translate(-50%, -100%);
}

.ds-tooltip[data-side='bottom'] {
  transform: translateX(-50%);
}

.ds-tooltip[data-side='right'] {
  transform: translateY(-50%);
}
</style>
