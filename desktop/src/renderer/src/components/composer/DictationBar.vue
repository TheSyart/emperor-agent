<script setup lang="ts">
/**
 * DictationBar — the recording controls that take the composer's bottom
 * row while dictating (RV-06, after Codex): × cancels and drops what was
 * heard; the waveform follows the microphone's loudness, newest on the
 * right, with silence as a row of dots; ■ stops and puts the text in. The
 * composer adds its send button after it. With reduced motion the waveform
 * does not scroll and shows only the current level. A polite live region
 * says when listening starts and when the text is being recognized.
 *
 * Props: phase (starting / listening / finishing), levels (0–1, oldest
 * first), shortcut (a label such as ⇧⌘D).
 * Emits: cancel, stop.
 */
import IconButton from '../ui/IconButton.vue'
import Spinner from '../ui/Spinner.vue'
import { computed } from 'vue'
import { useReducedMotion } from '../../composables/useReducedMotion'
import { DsClose, DsStopSquare } from '../icons/ds'
import type { DictationPhase } from './composerDictation'
import { dictationWaveSlots } from './dictationWave'

const props = defineProps<{
  phase: DictationPhase
  levels: readonly number[]
  shortcut: string
}>()
const emit = defineEmits<{ cancel: []; stop: [] }>()

const reducedMotion = useReducedMotion()
const slots = computed(() =>
  dictationWaveSlots(props.levels, { reducedMotion: reducedMotion.value }),
)
const listening = computed(() => props.phase === 'listening')
const live = computed(() =>
  props.phase === 'listening'
    ? '正在听写'
    : props.phase === 'finishing'
      ? '正在识别'
      : '',
)
</script>

<template>
  <div class="dictation-bar" :data-phase="phase">
    <IconButton
      class="dictation-cancel"
      label="取消听写"
      shape="circle"
      @click="emit('cancel')"
    >
      <DsClose :size="14" />
    </IconButton>
    <div class="dictation-wave" aria-hidden="true">
      <i
        v-for="(level, index) in slots"
        :key="index"
        :class="level === null ? 'dot' : 'bar'"
        :style="level === null ? undefined : { '--dictation-level': level }"
      />
    </div>
    <IconButton
      class="dictation-stop"
      label="停止听写"
      :shortcut="shortcut"
      shape="circle"
      variant="tonal"
      :disabled="!listening"
      @click="emit('stop')"
    >
      <DsStopSquare v-if="listening" :size="12" />
      <Spinner v-else size="sm" />
    </IconButton>
    <span class="dictation-live" aria-live="polite">{{ live }}</span>
  </div>
</template>

<style scoped>
.dictation-bar {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
}

.dictation-cancel,
.dictation-stop {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.dictation-cancel {
  background: var(--surface-hover);
  color: rgb(var(--text-2));
}

.dictation-cancel:hover {
  background: var(--surface-active);
  color: rgb(var(--text-1));
}

.dictation-stop {
  background: rgb(var(--text-1));
  color: rgb(var(--composer-fill));
}

.dictation-stop:disabled {
  background: var(--surface-hover);
  color: rgb(var(--text-2));
  cursor: default;
}

.dictation-cancel:focus-visible,
.dictation-stop:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

/* Slots 3px wide, 2px apart, the newest at the right edge; older ones
   leave on the left. A bar is 4–28px tall for levels 0–1. */
.dictation-wave {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-0-5);
  min-width: 0;
  height: var(--space-8);
  overflow: hidden;
}

.dictation-wave > i {
  flex: none;
  width: 3px;
}

.dictation-wave > .bar {
  height: calc(var(--space-1) + var(--dictation-level) * var(--space-6));
  border-radius: 2px;
  background: rgb(var(--text-2));
}

.dictation-wave > .dot {
  height: 3px;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-3));
}

.dictation-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
