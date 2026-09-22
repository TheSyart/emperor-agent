<script setup lang="ts">
/**
 * ConversationMarkdown — dsh MarkdownText look (16/28 body, 24/22/20/16
 * headings, 15/25 tables, inline code radius 6, 2px caption blockquote).
 * Prose renders through useMarkdown; fenced code through ui/CodeBlock (an
 * unclosed trailing fence while streaming is still a code block).
 *
 * Props: text; streaming? (reserved for incremental rendering).
 */
import { computed } from 'vue'
import CodeBlock from '../../ui/CodeBlock.vue'
import { splitMarkdownFences } from '../timelineModel'
import MarkdownHtml from './MarkdownHtml.vue'

const props = withDefaults(
  defineProps<{ text: string; streaming?: boolean }>(),
  { streaming: false },
)

const segments = computed(() => splitMarkdownFences(props.text))
</script>

<template>
  <div class="ds-md" :data-streaming="streaming || undefined">
    <template v-for="(segment, index) in segments" :key="index">
      <MarkdownHtml v-if="segment.kind === 'markdown'" :text="segment.text" />
      <CodeBlock
        v-else
        class="md-code"
        :code="segment.code"
        :lang="segment.lang || undefined"
      />
    </template>
  </div>
</template>

<style scoped>
.ds-md {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  overflow-wrap: anywhere;
  font: var(--font-md);
  color: rgb(var(--label-primary));
}

.ds-md :deep(.ds-md-html > *:first-child) {
  margin-top: 0;
}

.ds-md :deep(.ds-md-html > *:last-child) {
  margin-bottom: 0;
}

.ds-md :deep(p) {
  margin: var(--space-4) 0;
}

.ds-md :deep(strong) {
  font-weight: 600;
}

.ds-md :deep(h1) {
  margin: var(--space-8) 0 var(--space-4);
  font: 700 24px / 34px var(--font-sans);
}

.ds-md :deep(h2) {
  margin: var(--space-8) 0 var(--space-4);
  font: 700 22px / 32px var(--font-sans);
}

.ds-md :deep(h3) {
  margin: var(--space-8) 0 var(--space-4);
  font: 700 20px / 30px var(--font-sans);
}

.ds-md :deep(:is(h4, h5, h6)) {
  margin: var(--space-4) 0;
  font: 600 var(--fs-md) / var(--lh-md) var(--font-sans);
}

.ds-md :deep(:is(h4, h5, h6) + :is(ul, ol)) {
  margin-top: var(--space-2);
}

.ds-md :deep(a) {
  color: rgb(var(--accent-strong));
  text-decoration: none;
}

.ds-md :deep(a:hover) {
  text-decoration: underline;
}

.ds-md :deep(:is(ul, ol)) {
  margin: var(--space-4) 0;
  padding-left: calc(var(--space-4) + var(--space-0-5));
}

.ds-md :deep(ul) {
  list-style: disc;
}

.ds-md :deep(ol) {
  list-style: decimal;
}

.ds-md :deep(li:not(:first-child)) {
  margin-top: var(--space-1-5);
}

.ds-md :deep(li > :is(ul, ol)) {
  margin-top: var(--space-1);
  margin-bottom: 0;
}

.ds-md :deep(li > p) {
  margin: var(--space-2) 0;
}

.ds-md :deep(li::marker) {
  color: rgb(var(--label-secondary));
}

.ds-md :deep(hr) {
  height: 1px;
  margin: var(--space-8) 0;
  border: none;
  background: var(--border-l2);
}

.ds-md :deep(blockquote) {
  margin: var(--space-4) 0;
  padding-left: var(--space-3-5);
  border-left: 2px solid rgb(var(--label-caption));
  color: rgb(var(--label-secondary));
}

.ds-md :deep(:not(pre) > code) {
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: rgb(var(--inline-code-bg));
  font-family: var(--font-mono);
  font-size: 0.875em;
}

.ds-md :deep(.ds-md-html pre) {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  overflow: auto;
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font: var(--font-code);
}

.ds-md :deep(table) {
  width: 100%;
  margin: var(--space-4) 0;
  border-collapse: collapse;
}

/* Four or more columns keep their natural width and scroll (dsh md-table-wide). */
.ds-md :deep(table:has(th:nth-child(4), td:nth-child(4))) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}

.ds-md :deep(th) {
  min-width: 100px;
  padding: var(--space-2-5) var(--space-4);
  border-bottom: 1px solid var(--border-l3);
  font: 500 calc(var(--fs-base) - 1px) / 25px var(--font-sans);
  text-align: start;
}

.ds-md :deep(td) {
  min-width: 100px;
  padding: var(--space-2-5) var(--space-4);
  border-bottom: 1px solid var(--border-l2);
  font: 400 calc(var(--fs-base) - 1px) / 25px var(--font-sans);
}

.ds-md :deep(:is(th, td):first-child) {
  padding-left: 0;
}

.ds-md :deep(td:last-child) {
  padding-right: 0;
}

.ds-md :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-row);
}

.ds-md :deep(input[type='checkbox']) {
  margin: 0 var(--space-2) 0 0;
  accent-color: rgb(var(--label-secondary));
}
</style>
