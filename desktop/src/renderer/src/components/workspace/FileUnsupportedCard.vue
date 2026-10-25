<script setup lang="ts">
/**
 * FileUnsupportedCard — a file the Files pane cannot show (BUG-10): a zip,
 * a disk image, a program… Its type, size and when it changed, with
 * 「用默认应用打开」 (not for programs and scripts) and 「在访达中显示」.
 *
 * Props: target (the tab's preview input), preview.
 */
import { computed } from 'vue'
import type { FilePreviewInput, FilePreviewResult } from '@emperor/core/api'
import FileOpenActions from './FileOpenActions.vue'
import {
  fileBadge,
  fileTypeLabel,
  formatFileSize,
  formatFileTime,
} from './filePreviewModel'

const props = defineProps<{
  target: FilePreviewInput
  preview: FilePreviewResult
}>()

const facts = computed(() =>
  [
    fileTypeLabel(props.preview.name),
    formatFileSize(props.preview.bytes),
    props.preview.modifiedAt
      ? `${formatFileTime(props.preview.modifiedAt)} 修改`
      : '',
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>

<template>
  <div class="file-unsupported">
    <span class="file-unsupported-glyph" aria-hidden="true">{{
      fileBadge(preview.name)
    }}</span>
    <b>{{ preview.name }}</b>
    <span class="file-unsupported-facts">{{ facts }}</span>
    <FileOpenActions :target="target" :openable="preview.openable" />
  </div>
</template>

<style scoped>
.file-unsupported {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-3);
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-raised));
  text-align: center;
}

.file-unsupported-glyph {
  display: grid;
  place-items: center;
  width: var(--space-8);
  height: calc(var(--space-8) + var(--space-2));
  border-radius: var(--r-xs);
  background: rgb(var(--surface-overlay));
  box-shadow: 0 0 0 0.5px var(--hairline);
  color: rgb(var(--text-3));
  font: var(--font-xxxs);
  font-weight: var(--weight-semibold);
}

.file-unsupported b {
  color: rgb(var(--text-1));
  font: var(--font-xs);
  font-weight: var(--weight-medium);
  overflow-wrap: anywhere;
}

.file-unsupported-facts {
  color: rgb(var(--text-3));
  font: var(--font-xxs);
  font-variant-numeric: tabular-nums;
}
</style>
