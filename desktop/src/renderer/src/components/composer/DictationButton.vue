<script setup lang="ts">
/**
 * DictationButton — the composer's 听写 control (VO-03). Idle: a mic.
 * Starting (macOS may be asking for permission) and finishing: a spinner.
 * Listening: a stop glyph on a pulsing red ring, with × beside it to
 * cancel. The tooltip names the shortcut; a polite live region says when
 * listening starts and ends.
 *
 * Props: phase, shortcut (a label such as ⇧⌘D), disabled?.
 * Emits: toggle, cancel.
 */
import { computed } from 'vue'
import { DsClose, DsLoading, DsMic, DsStopSquare } from '../icons/ds'
import type { DictationPhase } from './composerDictation'

const props = defineProps<{
  phase: DictationPhase
  shortcut: string
  disabled?: boolean
}>()
const emit = defineEmits<{ toggle: []; cancel: [] }>()

const LABELS: Record<DictationPhase, string> = {
  idle: '听写',
  starting: '正在准备听写',
  listening: '结束听写',
  finishing: '正在识别',
}

const label = computed(() => LABELS[props.phase])
const title = computed(() => {
  switch (props.phase) {
    case 'idle':
      return `听写（${props.shortcut}）`
    case 'starting':
      return '正在准备听写，再点一次取消'
    case 'listening':
      return `结束听写，把文字放进输入框（${props.shortcut}）`
    default:
      return '正在识别…'
  }
})
const recording = computed(
  () => props.phase === 'starting' || props.phase === 'listening',
)
const live = computed(() =>
  props.phase === 'listening'
    ? '正在听写'
    : props.phase === 'finishing'
      ? '正在识别'
      : '',
)
</script>

<template>
  <div class="dictation" :data-phase="phase">
    <button
      v-if="recording"
      type="button"
      class="dictation-cancel"
      aria-label="取消听写"
      title="取消听写，不放进输入框"
      @click="emit('cancel')"
    >
      <DsClose :size="12" />
    </button>
    <button
      type="button"
      class="dictation-toggle"
      :aria-label="label"
      :title="title"
      :disabled="disabled || phase === 'finishing'"
      @click="emit('toggle')"
    >
      <DsLoading
        v-if="phase === 'starting' || phase === 'finishing'"
        :size="16"
        class="dictation-spin"
      />
      <DsStopSquare v-else-if="phase === 'listening'" :size="14" />
      <DsMic v-else :size="16" />
    </button>
    <span class="dictation-live" aria-live="polite">{{ live }}</span>
  </div>
</template>

<style scoped>
.dictation {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.dictation-toggle,
.dictation-cancel {
  display: grid;
  place-items: center;
  flex: none;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.dictation-toggle {
  width: var(--space-7);
  height: var(--space-7);
}

.dictation-cancel {
  width: var(--space-5);
  height: var(--space-5);
}

.dictation-toggle:hover:not(:disabled),
.dictation-cancel:hover {
  background: rgb(var(--interactive-bg-hover-solid));
  color: rgb(var(--label-primary));
}

.dictation-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.dictation[data-phase='listening'] .dictation-toggle {
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
  box-shadow: 0 0 0 2px rgb(var(--state-error) / 0.35);
  animation: dictation-pulse 1.6s ease-in-out infinite;
}

.dictation-spin {
  animation: dictation-spin 1s linear infinite;
}

.dictation-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes dictation-pulse {
  50% {
    box-shadow: 0 0 0 4px rgb(var(--state-error) / 0.12);
  }
}

@keyframes dictation-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
