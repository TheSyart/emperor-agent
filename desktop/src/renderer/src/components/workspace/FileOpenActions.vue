<script setup lang="ts">
/**
 * FileOpenActions — 「用默认应用打开」 and 「在访达中显示」 for a file of the
 * Files pane (BUG-10). Opening is offered only when Core marked the file
 * openable (not a program, script or bundle); Finder always is.
 *
 * Props: target (the tab's preview input), openable.
 */
import type { FilePreviewInput } from '@emperor/core/api'
import Button from '../ui/Button.vue'
import { useFileActions } from './useFileAddress'

const props = defineProps<{ target: FilePreviewInput; openable?: boolean }>()
const actions = useFileActions(() => props.target)
</script>

<template>
  <div class="file-open-actions">
    <Button
      v-if="openable"
      variant="secondary"
      size="sm"
      :loading="actions.busy.value === 'open'"
      @click="actions.open"
      >用默认应用打开</Button
    >
    <Button
      size="sm"
      :loading="actions.busy.value === 'reveal'"
      @click="actions.reveal"
      >在访达中显示</Button
    >
    <small v-if="actions.failure.value" role="alert">{{
      actions.failure.value
    }}</small>
  </div>
</template>

<style scoped>
.file-open-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
}

.file-open-actions small {
  flex-basis: 100%;
  color: rgb(var(--error));
  font: var(--font-xxs);
  text-align: center;
}
</style>
