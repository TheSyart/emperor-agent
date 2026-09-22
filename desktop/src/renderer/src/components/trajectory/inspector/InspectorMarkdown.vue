<script setup lang="ts">
/**
 * InspectorMarkdown — compact 13/20 markdown for the inspector (dsh
 * markdownPreview / markdownPayload). Rendered + sanitized by useMarkdown.
 *
 * Props: text; preview? (tighter padding for Summary sections).
 */
import { toRef } from 'vue'
import { useMarkdown } from '../../../composables/useMarkdown'

const props = withDefaults(defineProps<{ text: string; preview?: boolean }>(), {
  preview: false,
})
const { rendered } = useMarkdown(toRef(() => props.text))
</script>

<template>
  <!-- sanitized by useMarkdown (DOMPurify) -->
  <div class="traj-md" :data-preview="preview || undefined" v-html="rendered" />
</template>

<style scoped>
.traj-md {
  box-sizing: border-box;
  padding: var(--space-3-5);
  overflow-wrap: anywhere;
  color: rgb(var(--label-primary));
  font: var(--font-xs);
}

.traj-md[data-preview='true'] {
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
}

.traj-md :deep(> :first-child) {
  margin-top: 0;
}

.traj-md :deep(> :last-child) {
  margin-bottom: 0;
}

.traj-md :deep(:is(p, ul, ol)) {
  margin: var(--space-2) 0;
}

.traj-md :deep(:is(ul, ol)) {
  padding-left: var(--space-5);
}

.traj-md :deep(h1) {
  margin: var(--space-3) 0 var(--space-1-5);
  font: 600 16px / 22px var(--font-sans);
}

.traj-md :deep(h2) {
  margin: var(--space-3) 0 var(--space-1-5);
  font: 600 15px / 22px var(--font-sans);
}

.traj-md :deep(:is(h3, h4, h5, h6)) {
  margin: var(--space-2-5) 0 var(--space-1);
  font: 600 14px / 20px var(--font-sans);
}

.traj-md :deep(:not(pre) > code) {
  padding: 0 var(--space-1);
  border-radius: 2px;
  background: rgb(var(--inline-code-bg));
  font: 12px / 18px var(--font-mono);
}

.traj-md :deep(pre) {
  margin: var(--space-2) 0;
  padding: var(--space-2-5) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
}

.traj-md :deep(blockquote) {
  margin: var(--space-2) 0;
  padding-left: var(--space-2);
  border-left: 2px solid rgb(var(--label-caption));
  color: rgb(var(--label-secondary));
}

.traj-md :deep(table) {
  border-collapse: collapse;
  font: var(--font-xs);
}

.traj-md :deep(:is(th, td)) {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-l2);
}

.traj-md :deep(a) {
  color: rgb(var(--accent-strong));
}
</style>
