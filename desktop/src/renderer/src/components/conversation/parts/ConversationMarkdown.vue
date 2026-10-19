<script setup lang="ts">
/**
 * ConversationMarkdown — the reply's prose (UI-S03): no container, 15/26
 * body with 12px between paragraphs, headings on `--md-h1/h2/h3` (20/18/16,
 * all below the page title), 14/22 tables, inline code radius 6, 2px
 * caption blockquote. Links and inline references use `--text-link` with a
 * 12px source icon in front (a file type icon, or the site icon when 设置 ›
 * 常规 › 显示网站图标 is on).
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
import ResourceCard from '../resources/ResourceCard.vue'
import {
  resourceMarkdownSegments,
  type ResourceMarkdownSegment,
} from '../resources/resourceModel'

const props = withDefaults(
  defineProps<{
    text: string
    streaming?: boolean
    sourceMessageId?: string
  }>(),
  { streaming: false, sourceMessageId: 'markdown' },
)

type Segment =
  ReturnType<typeof splitMarkdownFences>[number] | ResourceMarkdownSegment
const segments = computed<Segment[]>(() =>
  splitMarkdownFences(props.text).flatMap<Segment>((segment) =>
    segment.kind === 'markdown' && !props.streaming
      ? resourceMarkdownSegments(segment.text, props.sourceMessageId)
      : [segment],
  ),
)
</script>

<template>
  <div class="ds-md" :data-streaming="streaming || undefined">
    <template v-for="(segment, index) in segments" :key="index">
      <MarkdownHtml
        v-if="segment.kind === 'markdown'"
        :text="segment.text"
        :streaming="streaming"
        :source-message-id="sourceMessageId"
      />
      <ResourceCard
        v-else-if="segment.kind === 'resource'"
        :resource="segment.resource"
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
  gap: var(--space-3);
  min-width: 0;
  overflow-wrap: anywhere;
  font: var(--type-body) var(--font-sans);
  color: rgb(var(--text-1));
}
.ds-md > :deep(.resource-card) {
  margin: 0;
}

.ds-md :deep(.ds-md-html > *:first-child) {
  margin-top: 0;
}

.ds-md :deep(.ds-md-html > *:last-child) {
  margin-bottom: 0;
}

.ds-md :deep(p) {
  margin: var(--space-3) 0;
}
.ds-md :deep(.md-image-preview) {
  display: block;
  max-width: min(100%, 480px);
  max-height: 480px;
  object-fit: contain;
  margin: var(--space-3) 0;
  border-radius: var(--radius-card);
}

.ds-md :deep(strong) {
  font-weight: 600;
}

.ds-md :deep(h1) {
  margin: var(--space-6) 0 var(--space-3);
  font: var(--weight-semibold) var(--md-h1) var(--font-sans);
}

.ds-md :deep(h2) {
  margin: var(--space-6) 0 var(--space-3);
  font: var(--weight-semibold) var(--md-h2) var(--font-sans);
}

.ds-md :deep(h3) {
  margin: var(--space-5) 0 var(--space-2);
  font: var(--weight-semibold) var(--md-h3) var(--font-sans);
}

.ds-md :deep(:is(h4, h5, h6)) {
  margin: var(--space-3) 0;
  font: var(--weight-semibold) var(--type-body) var(--font-sans);
}

.ds-md :deep(:is(h4, h5, h6) + :is(ul, ol)) {
  margin-top: var(--space-2);
}

.ds-md :deep(a) {
  color: rgb(var(--text-link));
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
  width: var(--icon-xs);
  height: var(--icon-xs);
  margin-inline-end: var(--space-1);
  vertical-align: -0.06em;
  background-color: rgb(var(--md-link-ink, var(--label-secondary)));
  -webkit-mask: var(--md-link-ico) center / contain no-repeat;
  mask: var(--md-link-ico) center / contain no-repeat;
}

/* Language and PDF badges: short text on a tint of the language's tone. */
.ds-md :deep(a.md-link-chip[data-md-badge]:not([data-md-custom-icon])::before) {
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
.ds-md :deep(a.md-link-chip[data-md-custom-icon][data-md-tone]) {
  --md-link-ink: var(--md-badge-tone);
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

.ds-md :deep(a.md-link-chip[data-md-link='web']) {
  max-width: calc(100% - var(--space-2));
  padding: 0 var(--space-0-5);
  margin-inline: var(--space-1);
  border-radius: var(--radius-xs);
  background: transparent;
  line-height: 1.85;
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
  transition: background var(--duration-fast) ease;
}
.ds-md :deep(a.md-link-chip[data-md-link='web']:hover) {
  background: var(--interactive-bg-hover);
}
.ds-md :deep(a.md-link-chip[data-md-link='web']:focus-visible) {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 3px;
}
.ds-md :deep(a.md-link-chip[data-md-link='web']::before) {
  width: var(--icon-xs);
  height: var(--icon-xs);
  margin-inline-end: var(--space-1-5);
}
.ds-md :deep(a.md-link-chip[data-resource-kind='github']::before) {
  --md-link-ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7'%3E%3Cpath d='M9 19c-4 1-4-2-6-3m12 6v-4c0-1-.3-2-1-2.6 3-.3 6-1.4 6-6.5 0-1.4-.5-2.7-1.4-3.7.3-1.2.3-2.4-.2-3.6 0 0-1.2-.4-3.6 1.4a13 13 0 0 0-7 0C5.4 1.2 4.2 1.6 4.2 1.6c-.5 1.2-.5 2.4-.2 3.6a5.5 5.5 0 0 0-1.4 3.7c0 5.1 3 6.2 6 6.5-.7.6-1 1.6-1 2.6v4'/%3E%3C/svg%3E");
}
.ds-md :deep(a.md-link-chip[data-site-letter]::before) {
  content: attr(data-site-letter) / '';
  mask: none;
  background: rgb(var(--accent-fill) / 0.14);
  color: rgb(var(--text-link));
  border-radius: var(--radius-xs);
  font: 600 0.7em/1.4 var(--font-sans);
  text-align: center;
  vertical-align: 0;
}
.ds-md :deep(a.md-link-chip[data-site-icon='ready']::before) {
  display: none;
}
.ds-md :deep(img.site-icon) {
  display: inline-block;
  flex: none;
  width: var(--icon-xs);
  height: var(--icon-xs);
  margin: 0 var(--space-1-5) 0 0;
  vertical-align: -0.125em;
  object-fit: contain;
  border-radius: var(--radius-xs);
  background: rgb(var(--nb-00));
}

.ds-md :deep(:is(ul, ol)) {
  margin: var(--space-3) 0;
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
  margin: var(--space-3) 0;
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
  margin: var(--space-3) 0;
  padding: var(--space-4);
  overflow: auto;
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font: var(--font-code);
}

.ds-md :deep(table) {
  width: 100%;
  margin: var(--space-3) 0;
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
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-l3);
  font: var(--weight-medium) var(--type-body-sm) var(--font-sans);
  text-align: start;
}

.ds-md :deep(td) {
  min-width: 100px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-l2);
  font: var(--weight-regular) var(--type-body-sm) var(--font-sans);
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

.ds-md :deep(img[role='button']) {
  cursor: zoom-in;
}

.ds-md :deep(img[role='button']:focus-visible) {
  outline: 2px solid rgb(var(--accent));
  outline-offset: var(--space-1);
}

.ds-md :deep(input[type='checkbox']) {
  margin: 0 var(--space-2) 0 0;
  accent-color: rgb(var(--label-secondary));
}

/* Filled color artwork must not become a solid monochrome mask. */
.ds-md :deep(a.md-link-chip[data-md-color]::before) {
  background: var(--md-link-image) center / contain no-repeat;
  -webkit-mask: none;
  mask: none;
}
</style>
