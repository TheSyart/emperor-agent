<script setup lang="ts">
/**
 * PromptDiff — Diff tab of a changed request header: unified jsdiff of the
 * system prompt and of the tool catalog JSON against the previous header.
 *
 * Props: before, after (ConversationPromptSnapshot).
 */
import { computed } from 'vue'
import type { ConversationPromptSnapshot } from '../../../trajectory/model'
import { promptDiffLines } from './inspectorModel'

const props = defineProps<{
  before: ConversationPromptSnapshot
  after: ConversationPromptSnapshot
}>()

const sections = computed(() => {
  const toolsBefore = JSON.stringify(props.before.tools, null, 2)
  const toolsAfter = JSON.stringify(props.after.tools, null, 2)
  return [
    {
      title: '系统提示词',
      lines: promptDiffLines(props.before.system, props.after.system),
    },
    {
      title: '工具',
      lines:
        toolsBefore === toolsAfter
          ? []
          : promptDiffLines(toolsBefore, toolsAfter),
    },
  ].filter((section) => section.lines.length > 0)
})
</script>

<template>
  <p v-if="sections.length === 0" class="no-payload">提示词没有变化</p>
  <div v-else class="traj-prompt-diff">
    <section v-for="section in sections" :key="section.title" class="section">
      <h3 class="title">{{ section.title }}</h3>
      <pre class="diff"><span
        v-for="(line, index) in section.lines"
        :key="index"
        class="line"
        :data-kind="line.kind"
      >{{ line.text || ' ' }}
</span></pre>
    </section>
  </div>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}

.traj-prompt-diff {
  display: flex;
  flex-direction: column;
  gap: var(--space-3-5);
  padding: var(--space-2-5) var(--space-3-5) var(--space-3-5);
}

.title {
  margin: 0 0 var(--space-1-5);
  color: rgb(var(--text-2));
  font: var(--weight-semibold) var(--fs-xs) / var(--lh-xs) var(--font-sans);
}

.diff {
  margin: 0;
  overflow: auto;
  color: rgb(var(--text-1));
  font: 11px / 17px var(--font-mono);
  white-space: pre;
}

.line {
  display: block;
  min-width: max-content;
  padding: 0 var(--space-1-5);
}

.line[data-kind='meta'] {
  color: rgb(var(--text-3));
  background: var(--surface-hover);
  user-select: none;
}

.line[data-kind='context'] {
  color: rgb(var(--text-2));
}

.line[data-kind='added'] {
  color: color-mix(in srgb, rgb(var(--ok)) 72%, rgb(var(--text-1)));
  background: rgb(var(--ok-soft));
}

.line[data-kind='removed'] {
  color: rgb(var(--error));
  background: color-mix(
    in srgb,
    rgb(var(--error)) 12%,
    rgb(var(--surface-base))
  );
}
</style>
