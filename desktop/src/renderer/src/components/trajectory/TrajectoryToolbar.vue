<script setup lang="ts">
/**
 * TrajectoryToolbar — dsh 32px toolbar over the trajectory: Duration toggle
 * (recorded durations vs equal-width operations), fold / unfold every turn,
 * fold / unfold every assistant's tool calls, and the ledger search (the
 * query is debounced; ↑ / ↓ step through the matches with an `n / N`
 * counter; Enter = next, Shift+Enter = previous, Escape clears), and the
 * right-aligned 详情 toggle that collapses / reopens the inspector column.
 *
 * Props: actualDuration; allTurnsCollapsed; allAssistantsCollapsed;
 * query (v-model:query, debounced by `debounceMs`, default 120);
 * matchCount; matchPosition (0-based cursor, -1 none); inspectorOpen.
 * Emits: update:actualDuration, toggle-turns, toggle-calls,
 * update:query, step(direction ±1), toggle-inspector.
 */
import { PanelRight } from 'lucide-vue-next'
import { onBeforeUnmount, ref, watch } from 'vue'
import DsChevronDown from '../icons/ds/DsChevronDown.vue'
import DsChevronUp from '../icons/ds/DsChevronUp.vue'
import DsSearch from '../icons/ds/DsSearch.vue'

const props = withDefaults(
  defineProps<{
    actualDuration: boolean
    allTurnsCollapsed: boolean
    allAssistantsCollapsed: boolean
    query: string
    matchCount?: number
    matchPosition?: number
    debounceMs?: number
    inspectorOpen?: boolean
  }>(),
  { matchCount: 0, matchPosition: -1, debounceMs: 120, inspectorOpen: false },
)
const emit = defineEmits<{
  'update:actualDuration': [value: boolean]
  'toggle-turns': []
  'toggle-calls': []
  'update:query': [value: string]
  step: [direction: 1 | -1]
  'toggle-inspector': []
}>()

const draft = ref(props.query)
let timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.query,
  (value) => {
    if (value !== draft.value) draft.value = value
  },
)

function onInput(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value
  clearTimeout(timer)
  timer = setTimeout(() => emit('update:query', draft.value), props.debounceMs)
}

function flush(): void {
  clearTimeout(timer)
  if (draft.value !== props.query) emit('update:query', draft.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    flush()
    emit('step', event.shiftKey ? -1 : 1)
  } else if (event.key === 'Escape' && draft.value !== '') {
    event.preventDefault()
    draft.value = ''
    flush()
  }
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="traj-toolbar" role="toolbar" aria-label="Trajectory toolbar">
    <div class="actions">
      <button
        type="button"
        class="action"
        aria-label="Use actual duration"
        :aria-pressed="actualDuration"
        :title="
          actualDuration ? 'Use equal-width operations' : 'Use actual duration'
        "
        @click="emit('update:actualDuration', !actualDuration)"
      >
        <svg
          class="toggle-icon"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 4.75V8l2.25 1.5" />
        </svg>
        Duration
      </button>
      <button
        type="button"
        class="action"
        data-fold="turns"
        :aria-label="allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'"
        :aria-pressed="allTurnsCollapsed"
        :title="allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'"
        @click="emit('toggle-turns')"
      >
        <span class="action-icon" aria-hidden="true">{{
          allTurnsCollapsed ? '⊞' : '⊟'
        }}</span>
        Turns
      </button>
      <button
        type="button"
        class="action"
        data-fold="calls"
        :aria-label="allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'"
        :aria-pressed="allAssistantsCollapsed"
        :title="allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'"
        @click="emit('toggle-calls')"
      >
        <span class="action-icon" aria-hidden="true">{{
          allAssistantsCollapsed ? '⊞' : '⊟'
        }}</span>
        Calls
      </button>
    </div>
    <div class="search" :data-active="query !== '' || undefined">
      <DsSearch :size="11" class="search-icon" />
      <input
        type="search"
        class="search-input"
        aria-label="Search trajectory"
        placeholder="Search"
        :value="draft"
        @input="onInput"
        @keydown="onKeydown"
      />
      <template v-if="query !== ''">
        <span class="count" data-search-count aria-live="polite">{{
          matchCount === 0
            ? '0'
            : `${matchPosition < 0 ? '–' : matchPosition + 1}/${matchCount}`
        }}</span>
        <button
          type="button"
          class="step"
          aria-label="Previous match"
          :disabled="matchCount === 0"
          @click="emit('step', -1)"
        >
          <DsChevronUp :size="12" />
        </button>
        <button
          type="button"
          class="step"
          aria-label="Next match"
          :disabled="matchCount === 0"
          @click="emit('step', 1)"
        >
          <DsChevronDown :size="12" />
        </button>
      </template>
    </div>
    <button
      type="button"
      class="action inspector-toggle"
      aria-label="详情"
      :aria-pressed="inspectorOpen"
      :title="inspectorOpen ? '收起详情' : '展开详情'"
      @click="emit('toggle-inspector')"
    >
      <PanelRight :size="12" aria-hidden="true" />
      详情
    </button>
  </div>
</template>

<style scoped>
.traj-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 32px;
  padding: 0 var(--space-1-5);
  border-bottom: 1px solid var(--border-l2);
  background: rgb(var(--bg-layer-1));
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.action {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  height: 20px;
  padding: 0 calc(var(--space-1) + 1px);
  border: 0;
  border-radius: 2px;
  color: rgb(var(--label-tertiary));
  background: transparent;
  cursor: pointer;
  font: var(--font-xxs);
}

.action:hover,
.action[aria-pressed='true'] {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.action:focus-visible,
.step:focus-visible {
  outline: 1px solid rgb(var(--focus-ring));
  outline-offset: 1px;
}

.toggle-icon {
  flex: none;
  width: 12px;
  height: 12px;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.action-icon {
  color: rgb(var(--label-tertiary));
  font: 14px / 14px var(--font-mono);
}

.search {
  display: flex;
  flex: 0 1 220px;
  align-items: center;
  gap: var(--space-1);
  min-width: 96px;
  height: 22px;
  margin-left: auto;
  padding: 0 var(--space-1-5);
  border: 1px solid var(--border-l2);
  border-radius: 2px;
  color: rgb(var(--label-caption));
  background: rgb(var(--bg-layer-2));
}

.search:hover {
  border-color: rgb(var(--label-caption));
}

.search:focus-within {
  border-color: rgb(var(--accent-fill));
  background: rgb(var(--bg-layer-1));
}

.search-icon {
  flex: none;
}

.search-input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  color: rgb(var(--label-primary));
  background: transparent;
  font: var(--font-xxs);
}

.search-input::placeholder {
  color: rgb(var(--label-caption));
}

.count {
  flex: none;
  color: rgb(var(--label-tertiary));
  font: var(--font-xxxs);
  font-variant-numeric: tabular-nums;
}

.step {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  color: rgb(var(--label-tertiary));
  background: transparent;
  cursor: pointer;
}

.step:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.step:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
