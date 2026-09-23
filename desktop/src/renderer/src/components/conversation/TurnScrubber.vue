<script setup lang="ts">
/**
 * TurnScrubber — the turn strip on the left edge of the chat body (async
 * chunk): one tick per user message of the loaded window, the reader's turn
 * highlighted. Click, or ↑ / ↓ / Home / End while the strip has focus
 * (roving tab stop), emits `select` with the prompt's node key —
 * ConversationView reveals it through ChatTimeline.scrollToKey. Hover or
 * focus shows the prompt's first 40 characters beside the tick.
 *
 * ConversationView mounts it only with ≥ 3 turns; below a 560px
 * conversation column it hides (container query).
 *
 * Props: ticks (timelineModel.turnTicks), active (activeTurnTick index).
 * Emits: select(key).
 */
import { computed, ref, watch } from 'vue'
import type { TurnTick } from './timelineModel'

const props = defineProps<{ ticks: TurnTick[]; active: number }>()
const emit = defineEmits<{ select: [key: string] }>()

const strip = ref<HTMLElement | null>(null)
/** Tick buttons by index (a function ref: v-for ref arrays are unordered). */
const buttons: (HTMLButtonElement | undefined)[] = []
/** Tick holding keyboard focus (null while focus is elsewhere). */
const focused = ref<number | null>(null)
const hovered = ref<number | null>(null)
const bubbleTop = ref(0)

const stop = computed(() =>
  Math.min(props.ticks.length - 1, Math.max(0, focused.value ?? props.active)),
)
const previewIndex = computed(() => hovered.value ?? focused.value)
const preview = computed(() =>
  previewIndex.value === null ? null : props.ticks[previewIndex.value],
)

watch(previewIndex, (index) => {
  const button = index === null ? undefined : buttons[index]
  if (button) bubbleTop.value = button.offsetTop + button.offsetHeight / 2
})

function select(index: number): void {
  const tick = props.ticks[index]
  if (tick) emit('select', tick.key)
}

function onClick(index: number): void {
  focused.value = index
  select(index)
}

function onKeydown(event: KeyboardEvent): void {
  const last = props.ticks.length - 1
  const current = stop.value
  const next =
    event.key === 'ArrowUp'
      ? current - 1
      : event.key === 'ArrowDown'
        ? current + 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null
  if (next === null) return
  event.preventDefault()
  const index = Math.min(last, Math.max(0, next))
  focused.value = index
  buttons[index]?.focus()
  select(index)
}

function onFocusOut(event: FocusEvent): void {
  if (!strip.value?.contains(event.relatedTarget as Node | null))
    focused.value = null
}
</script>

<template>
  <nav
    ref="strip"
    class="turn-scrubber"
    aria-label="对话轮次"
    @keydown="onKeydown"
    @focusout="onFocusOut"
    @pointerleave="hovered = null"
  >
    <button
      v-for="(tick, index) in ticks"
      :key="tick.key"
      :ref="(el) => (buttons[index] = (el as HTMLButtonElement) || undefined)"
      type="button"
      class="tick"
      :data-active="index === active || undefined"
      :tabindex="index === stop ? 0 : -1"
      :aria-label="`第 ${tick.turn} 轮：${tick.label}`"
      :aria-current="index === active ? 'location' : undefined"
      @click="onClick(index)"
      @focus="focused = index"
      @pointerenter="hovered = index"
    >
      <span class="mark" aria-hidden="true" />
    </button>
    <div
      v-if="preview"
      class="bubble ds-fade-in"
      aria-hidden="true"
      :style="{ top: `${bubbleTop}px` }"
    >
      {{ preview.label }}
    </div>
  </nav>
</template>

<style scoped>
.turn-scrubber {
  position: absolute;
  top: 50%;
  left: var(--space-1);
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  max-height: calc(100% - 2 * var(--space-8));
  transform: translateY(-50%);
}

.tick {
  display: flex;
  flex: 0 1 var(--space-3);
  align-items: center;
  width: var(--space-6);
  min-height: 3px;
  padding: 0 var(--space-1-5);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  cursor: pointer;
}

.mark {
  width: var(--space-2-5);
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--label-caption) / 0.7);
  transition:
    background-color var(--duration-ds-fast) ease,
    transform var(--duration-ds-fast) ease;
  transform-origin: left center;
}

.tick:hover .mark,
.tick:focus-visible .mark {
  background: rgb(var(--label-secondary));
}

.tick[data-active] .mark {
  background: rgb(var(--label-primary));
  transform: scaleX(1.6);
}

.tick:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.bubble {
  position: absolute;
  left: calc(100% + var(--space-1));
  width: max-content;
  max-width: 280px;
  padding: calc(var(--space-1) - 1px) calc(var(--space-2) - 1px);
  border-radius: var(--radius-row);
  background: rgb(var(--tooltip-bg));
  color: rgb(var(--tooltip-fg));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  pointer-events: none;
  transform: translateY(-50%);
}

@container conversation (max-width: 559px) {
  .turn-scrubber {
    display: none;
  }
}
</style>
