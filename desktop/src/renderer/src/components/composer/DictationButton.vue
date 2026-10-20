<script setup lang="ts">
/**
 * DictationButton — the composer's 听写 microphone (VO-03). Pressing it
 * starts a dictation; from then until it ends the recording bar
 * (DictationBar.vue) takes the composer's bottom row, with cancel, stop and
 * send. The tooltip names the shortcut.
 *
 * Props: shortcut (a label such as ⇧⌘D), disabled?.
 * Emits: start.
 */
import IconButton from '../ui/IconButton.vue'
import { DsMic } from '../icons/ds'

defineProps<{ shortcut: string; disabled?: boolean }>()
const emit = defineEmits<{ start: [] }>()
</script>

<template>
  <IconButton
    class="dictation-mic"
    label="听写"
    :shortcut="shortcut"
    size="md"
    shape="circle"
    :disabled="disabled"
    @click="emit('start')"
  >
    <DsMic :size="16" />
  </IconButton>
</template>

<style scoped>
.dictation-mic {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.dictation-mic:hover:not(:disabled) {
  background: rgb(var(--surface-hover-solid));
  color: rgb(var(--label-primary));
}

.dictation-mic:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
