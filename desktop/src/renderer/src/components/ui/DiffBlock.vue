<script setup lang="ts">
/**
 * DiffBlock — dsh inline-diff surface for file mutations (write / edit /
 * memory_edit / prompt diff). Line diff via jsdiff with 3 lines of context;
 * floating copy control, head/tail cap, `└ +A -R · N file(s)` footer.
 *
 * Props:
 * - diffs: DiffHunk[] ({ path, oldText | null, newText }).
 * - maxLines (default 16): body rows before the middle collapses.
 * - context (default 3): unchanged lines kept around each change.
 */
import { computed, ref } from 'vue'
import {
  buildDiffRows,
  diffCopyText,
  diffFooter,
  type DiffHunk,
} from './diffRows'
import { capRows, DEFAULT_BLOCK_MAX_LINES, headTailCap } from './headTailCap'
import { useCopyFeedback } from './useCopyFeedback'

const props = withDefaults(
  defineProps<{ diffs: DiffHunk[]; maxLines?: number; context?: number }>(),
  { maxLines: DEFAULT_BLOCK_MAX_LINES, context: 3 },
)

const expanded = ref(false)
const result = computed(() => buildDiffRows(props.diffs, props.context))
const cap = computed(() =>
  headTailCap(result.value.rows.length, props.maxLines, expanded.value),
)
const visible = computed(() => capRows(result.value.rows, cap.value))
const { copied, copy } = useCopyFeedback(() => diffCopyText(result.value.rows))
</script>

<template>
  <div v-if="result.rows.length" class="ds-diff" data-diff>
    <button type="button" class="copy" @click="copy">
      {{ copied ? '复制成功' : '复制' }}
    </button>
    <div class="body">
      <div
        v-for="(row, index) in visible.head"
        :key="`h${index}`"
        :class="['line', `line--${row.kind}`]"
        v-text="row.text"
      />
      <button
        v-if="cap.hidden > 0"
        type="button"
        class="expand"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : `… 其余 ${cap.hidden} 行` }}
      </button>
      <div
        v-for="(row, index) in visible.tail"
        :key="`t${index}`"
        :class="['line', `line--${row.kind}`]"
        v-text="row.text"
      />
    </div>
    <div class="footer">{{ diffFooter(result) }}</div>
  </div>
</template>

<style scoped>
.ds-diff {
  position: relative;
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.copy {
  position: absolute;
  top: var(--space-2);
  right: var(--space-3);
  z-index: var(--z-raised);
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  cursor: pointer;
}

.body {
  padding: var(--space-3) var(--space-3-5);
  font: var(--font-code);
  overflow-x: auto;
  overflow-y: hidden;
}

.line {
  min-height: var(--lh-code);
  white-space: pre;
}

.line--path {
  padding-right: calc(var(--space-8) * 2);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.line--gap,
.line--ctx {
  color: rgb(var(--label-tertiary));
}

.line--ctx::before {
  content: '  ';
}

.line--del,
.line--del::before {
  color: rgb(var(--danger));
}

.line--del {
  background: rgb(var(--danger) / 0.06);
}

.line--del::before {
  content: '- ';
}

.line--add,
.line--add::before {
  color: rgb(var(--ok));
}

.line--add {
  background: rgb(var(--ok) / 0.07);
}

.line--add::before {
  content: '+ ';
}

.expand {
  display: block;
  width: 100%;
  padding: 0;
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

.footer {
  padding: 0 var(--space-3-5) var(--space-3);
  font: var(--font-code);
  color: rgb(var(--label-tertiary));
}
</style>
