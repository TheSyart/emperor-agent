<script setup lang="ts">
/**
 * MessageIconActions — dsh 28px icon action row under a message: copy
 * (check swap after writing), optional edit, and a hover-revealed caption
 * (`14:05 · 用时 12s · 首字 0.8s · 34 tok/s`) before (user) or after
 * (assistant) the icons. The caption fades in when the nearest
 * `[data-time-hover-root]` ancestor is hovered or focused.
 *
 * Props: text, time?, runMs?, ttftMs?, tokensPerSecond?, clock, editable?.
 * Emits: edit(text).
 */
import { computed } from 'vue'
import { DsCheck, DsCopy, DsEdit } from '../../icons/ds'
import Tooltip from '../../ui/Tooltip.vue'
import { useCopyFeedback } from '../../ui/useCopyFeedback'
import {
  formatClock,
  formatLatency,
  formatRunDuration,
  formatTokensPerSecond,
} from '../chatFormat'

const props = withDefaults(
  defineProps<{
    text: string
    time?: number
    runMs?: number
    ttftMs?: number
    tokensPerSecond?: number
    clock: 'start' | 'end'
    editable?: boolean
  }>(),
  {
    time: undefined,
    runMs: undefined,
    ttftMs: undefined,
    tokensPerSecond: undefined,
    editable: false,
  },
)
const emit = defineEmits<{ edit: [text: string] }>()

const { copied, copy } = useCopyFeedback(() => props.text)

const caption = computed(() => {
  const parts: string[] = []
  if (props.time !== undefined) parts.push(formatClock(props.time))
  if (props.runMs !== undefined)
    parts.push(`用时 ${formatRunDuration(props.runMs)}`)
  if (props.ttftMs !== undefined)
    parts.push(`首字 ${formatLatency(props.ttftMs)}`)
  if (props.tokensPerSecond !== undefined)
    parts.push(formatTokensPerSecond(props.tokensPerSecond))
  return parts
})
</script>

<template>
  <div class="ds-message-actions">
    <span
      v-if="clock === 'start' && caption.length"
      class="ds-msg-caption start"
    >
      <template v-for="(part, index) in caption" :key="index">
        <span v-if="index > 0" class="caption-dot" aria-hidden="true">·</span>
        {{ part }}
      </template>
    </span>
    <Tooltip :label="copied ? '已复制' : '复制'" side="bottom">
      <button
        type="button"
        class="action"
        :aria-label="copied ? '已复制' : '复制'"
        @click="copy"
      >
        <DsCheck v-if="copied" :size="16" />
        <DsCopy v-else :size="16" />
      </button>
    </Tooltip>
    <Tooltip v-if="editable" label="编辑后重新发送" side="bottom">
      <button
        type="button"
        class="action"
        aria-label="编辑后重新发送"
        @click="emit('edit', text)"
      >
        <DsEdit :size="16" />
      </button>
    </Tooltip>
    <slot />
    <span v-if="clock === 'end' && caption.length" class="ds-msg-caption end">
      <template v-for="(part, index) in caption" :key="index">
        <span v-if="index > 0" class="caption-dot" aria-hidden="true">·</span>
        {{ part }}
      </template>
    </span>
  </div>
</template>

<style scoped>
.ds-message-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  height: var(--space-7);
}

.ds-msg-caption {
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--label-tertiary));
  white-space: nowrap;
}

.ds-msg-caption.start {
  padding-right: var(--space-3);
}

.ds-msg-caption.end {
  padding-left: var(--space-3);
}

.caption-dot {
  margin: 0 var(--space-2);
}

.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-7);
  height: var(--space-7);
  padding: var(--space-1-5);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.action:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}
</style>

<style>
/* Hover reveal keyed on an ancestor outside this component (unscoped:
   Vue's :global() would drop the descendant part of the selector). */
@media (hover: hover) {
  [data-time-hover-root] .ds-msg-caption {
    opacity: 0;
    transition: opacity var(--duration-instant) ease;
  }

  [data-time-hover-root]:hover .ds-msg-caption,
  [data-time-hover-root]:focus-within .ds-msg-caption {
    opacity: 1;
  }
}
</style>
