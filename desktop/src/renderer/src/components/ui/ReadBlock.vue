<script setup lang="ts">
/**
 * ReadBlock — dsh line-numbered file window (read tool): banner with path
 * label, "显示 n / total 行", language and copy; highlighted body with a
 * fixed 48px gutter; head/tail cap.
 *
 * Props:
 * - lines: { number, text }[] (the returned window).
 * - totalLines: file length (windowed reads show the count).
 * - label?: banner label (usually the path).
 * - lang?: language id; falls back to the label's extension.
 * - maxLines (default 16).
 */
import { computed, ref } from 'vue'
import { highlightCodeLines } from './codeHighlight'
import { capRows, DEFAULT_BLOCK_MAX_LINES, headTailCap } from './headTailCap'
import { useCopyFeedback } from './useCopyFeedback'
import { escapeHtml } from '../workspace/fileHighlight'
import type { ReadBlockLine } from './blockTypes'

const props = withDefaults(
  defineProps<{
    lines: ReadBlockLine[]
    totalLines: number
    label?: string
    lang?: string
    maxLines?: number
  }>(),
  {
    label: undefined,
    lang: undefined,
    maxLines: DEFAULT_BLOCK_MAX_LINES,
  },
)

const expanded = ref(false)
const raw = computed(() => props.lines.map((line) => line.text).join('\n'))
const html = computed(
  () =>
    highlightCodeLines(raw.value, props.lang, props.label) ??
    props.lines.map((line) => escapeHtml(line.text)),
)
const rows = computed(() =>
  props.lines.map((line, index) => ({
    number: line.number,
    html: html.value[index] ?? '',
  })),
)
const cap = computed(() =>
  headTailCap(rows.value.length, props.maxLines, expanded.value),
)
const visible = computed(() => capRows(rows.value, cap.value))
const windowed = computed(() => props.lines.length < props.totalLines)
const { copied, copy } = useCopyFeedback(() => raw.value)
</script>

<template>
  <div class="ds-read" data-read>
    <div class="banner">
      <span class="label">{{ label ?? '' }}</span>
      <span class="actions">
        <span v-if="windowed" class="count"
          >显示 {{ lines.length }} / {{ totalLines }} 行</span
        >
        <span v-if="lang" class="lang">{{ lang }}</span>
        <button v-if="lines.length" type="button" class="copy" @click="copy">
          {{ copied ? '复制成功' : '复制' }}
        </button>
      </span>
    </div>
    <div class="body ds-hl">
      <div v-for="row in visible.head" :key="row.number" class="line">
        <span class="gutter" aria-hidden="true">{{ row.number }}</span>
        <!-- highlight.js spans over escaped source text -->
        <span class="content" v-html="row.html" />
      </div>
      <button
        v-if="cap.hidden > 0"
        type="button"
        class="expand"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : `… 其余 ${cap.hidden} 行` }}
      </button>
      <div v-for="row in visible.tail" :key="`t${row.number}`" class="line">
        <span class="gutter" aria-hidden="true">{{ row.number }}</span>
        <span class="content" v-html="row.html" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds-read {
  --read-gutter: calc(var(--space-6) * 2);

  position: relative;
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: calc(var(--space-2) + 1px) var(--space-3-5);
  background: rgb(var(--code-banner-bg));
  border-top-left-radius: var(--radius-card);
  border-top-right-radius: var(--radius-card);
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-primary));
}

.actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-3);
}

.count,
.copy {
  font: var(--font-xs);
}

.count {
  color: rgb(var(--label-tertiary));
}

.lang {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.copy {
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.body {
  padding: var(--space-3) 0;
  font: var(--font-code);
  overflow-x: auto;
  overflow-y: hidden;
}

.line {
  display: flex;
  min-height: var(--lh-code);
  line-height: var(--lh-code);
  white-space: pre;
}

.gutter {
  flex: none;
  width: var(--read-gutter);
  padding-right: var(--space-3-5);
  text-align: right;
  color: rgb(var(--label-tertiary));
  user-select: none;
}

.expand {
  display: block;
  width: 100%;
  padding: 0 0 0 var(--read-gutter);
  border: none;
  background: transparent;
  color: rgb(var(--label-tertiary));
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.expand:hover {
  color: rgb(var(--label-secondary));
}
</style>
