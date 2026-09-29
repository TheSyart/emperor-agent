<script setup lang="ts">
/**
 * ConversationMarkdown — dsh MarkdownText look (16/28 body, 24/22/20/16
 * headings, 15/25 tables, inline code radius 6, 2px caption blockquote).
 * Prose renders through useMarkdown; fenced code through ui/CodeBlock (an
 * unclosed trailing fence while streaming is still a code block). Local
 * file and web links read as a type icon plus an accent name (contract §4):
 * data-md-icon picks the icon, languages and PDF draw data-md-badge on a
 * data-md-tone tint, and a missing file (MarkdownHtml asks Core) is struck.
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
      <MarkdownHtml
        v-if="segment.kind === 'markdown'"
        :text="segment.text"
        :streaming="streaming"
      />
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

/* Document links: icon + accent name, body line height, no border. One
   unit, so the icon never wraps away from the name. */
.ds-md :deep(a.md-link-chip) {
  display: inline-block;
  max-width: 100%;
  font-weight: 500;
  cursor: pointer;
}

.ds-md :deep(a.md-link-chip::before) {
  content: '' / '';
  display: inline-block;
  width: 1em;
  height: 1em;
  margin-inline-end: 0.25em;
  vertical-align: -0.14em;
  background-color: rgb(var(--md-link-ink, var(--label-secondary)));
  -webkit-mask: var(--md-link-ico) center / contain no-repeat;
  mask: var(--md-link-ico) center / contain no-repeat;
}

/* Language and PDF badges: short text on a tint of the language's tone. */
.ds-md :deep(a.md-link-chip[data-md-badge]::before) {
  content: attr(data-md-badge) / '';
  width: auto;
  min-width: 1.6em;
  height: auto;
  padding: 0 0.35em;
  border-radius: var(--radius-xs);
  background: rgb(var(--md-badge-tone, var(--label-secondary)) / 0.14);
  color: rgb(var(--md-badge-tone, var(--label-secondary)));
  font: 700 0.625em / 1.6 var(--font-mono);
  text-align: center;
  vertical-align: 0.16em;
  -webkit-mask: none;
  mask: none;
}

.ds-md :deep(a.md-link-chip[data-md-tone='blue']) {
  --md-badge-tone: var(--tone-blue);
}

.ds-md :deep(a.md-link-chip[data-md-tone='cyan']) {
  --md-badge-tone: var(--tone-cyan);
}

.ds-md :deep(a.md-link-chip[data-md-tone='warn']) {
  --md-badge-tone: var(--warn);
}

.ds-md :deep(a.md-link-chip[data-md-tone='ok']) {
  --md-badge-tone: var(--ok);
}

.ds-md :deep(a.md-link-chip[data-md-tone='brand']) {
  --md-badge-tone: var(--brand);
}

.ds-md :deep(a.md-link-chip[data-md-tone='accent']) {
  --md-badge-tone: var(--accent);
}

.ds-md :deep(a.md-link-chip[data-md-tone='danger']) {
  --md-badge-tone: var(--danger);
}

/* A file Core cannot find: struck through and dimmed, icon included. */
.ds-md :deep(a.md-link-chip[data-md-state='missing']) {
  --md-link-ink: var(--label-tertiary);
  --md-badge-tone: var(--label-tertiary);
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
  cursor: default;
}

.ds-md :deep(a.md-link-chip[data-md-icon='file']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='document']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3Cpath d='M10 9H8'/%3E%3Cpath d='M16 13H8'/%3E%3Cpath d='M16 17H8'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='data']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1'/%3E%3Cpath d='M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='code']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3Cpath d='m10 12.5-2 2.5 2 2.5'/%3E%3Cpath d='m14 12.5 2 2.5-2 2.5'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='image']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='sheet']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2'/%3E%3Cpath d='M3 9h18'/%3E%3Cpath d='M3 15h18'/%3E%3Cpath d='M9 9v12'/%3E%3Cpath d='M15 9v12'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='archive']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='20' height='5' x='2' y='3' rx='1'/%3E%3Cpath d='M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'/%3E%3Cpath d='M10 12h4'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='folder']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/%3E%3C/svg%3E");
}

.ds-md :deep(a.md-link-chip[data-md-icon='web']) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'/%3E%3Cpath d='M2 12h20'/%3E%3C/svg%3E");
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
