<script setup lang="ts">
/**
 * CodeBlock — dsh code surface: sticky banner (language + copy) over a
 * highlight.js body, 13/22 mono, radius 12.
 *
 * Props:
 * - code: source text (a trailing newline is trimmed for display).
 * - lang?: markdown info string / language id; unknown renders plain text.
 * - small?: 12/18 in-row variant (tool bodies).
 * - copyLabel / copiedLabel: localized copy-button text.
 */
import { computed } from 'vue'
import { highlightCodeHtml } from './codeHighlight'
import { useCopyFeedback } from './useCopyFeedback'

const props = withDefaults(
  defineProps<{
    code: string
    lang?: string
    small?: boolean
    copyLabel?: string
    copiedLabel?: string
  }>(),
  {
    lang: undefined,
    small: false,
    copyLabel: '复制',
    copiedLabel: '复制成功',
  },
)

const trimmed = computed(() =>
  props.code.endsWith('\n') ? props.code.slice(0, -1) : props.code,
)
const rendered = computed(() => highlightCodeHtml(trimmed.value, props.lang))
const { copied, copy } = useCopyFeedback(() => trimmed.value)
</script>

<template>
  <div class="ds-code" :data-small="small || undefined">
    <div class="banner-wrap">
      <div class="banner">
        <span class="infostring">{{ lang ?? '' }}</span>
        <button type="button" class="copy" @click="copy">
          {{ copied ? copiedLabel : copyLabel }}
        </button>
      </div>
    </div>
    <!-- highlight.js output is a span tree generated from escaped source text. -->
    <pre class="ds-hl"><code v-html="rendered.html" /></pre>
  </div>
</template>

<style scoped>
.ds-code {
  position: relative;
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.banner-wrap {
  position: sticky;
  top: 0;
  z-index: var(--z-raised);
  background: rgb(var(--bg-base));
  border-top-left-radius: var(--radius-card);
  border-top-right-radius: var(--radius-card);
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: calc(var(--space-2) + 1px) var(--space-3-5);
  background: rgb(var(--code-banner-bg));
  font: var(--font-xs);
  border-top-left-radius: var(--radius-card);
  border-top-right-radius: var(--radius-card);
}

.infostring {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-primary));
}

.copy {
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  cursor: pointer;
}

.copy:hover {
  color: rgb(var(--label-primary));
}

pre {
  margin: 0;
  padding: var(--space-4);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font: var(--font-code);
  background: rgb(var(--code-block-bg));
  border-bottom-left-radius: var(--radius-card);
  border-bottom-right-radius: var(--radius-card);
}

[data-small] pre {
  padding: var(--space-3) var(--space-3-5);
  font: var(--font-code-small);
}

pre code {
  font: inherit;
  background: none;
  padding: 0;
}
</style>
