<script setup lang="ts">
/**
 * CompactionRow — dsh compaction marker: one dim 24px row (context icon at
 * rest, chevron on hover) `上下文已压缩 · 已压缩 10 条消息，约 415 tokens`;
 * the disclosure shows the summary markdown. Running shimmers; an error
 * shows the danger message.
 */
import { computed } from 'vue'
import type { CompactionChatNode } from '../../../conversation/types'
import { DsApi, DsChevronDown } from '../../icons/ds'
import { useExpansion } from '../chatContext'
import { formatTokens } from '../chatFormat'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'

const props = defineProps<{ node: CompactionChatNode }>()
const open = useExpansion(() => `${props.node.key}:summary`)

const data = computed(() => props.node.data)
const expandable = computed(
  () => data.value.status === 'done' && data.value.summary !== null,
)
const title = computed(() =>
  data.value.status === 'running'
    ? '正在压缩上下文'
    : data.value.status === 'error'
      ? '上下文压缩失败'
      : data.value.sourceCommandId !== undefined
        ? '已手动压缩上下文'
        : '上下文已压缩',
)
const summary = computed(() => {
  const d = data.value
  if (d.status === 'error') return d.error ?? ''
  if (d.status === 'running') return ''
  if (d.shadowedItemCount !== null && d.shadowedTokenCount !== null)
    return `已压缩 ${d.shadowedItemCount} 条消息，约 ${formatTokens(d.shadowedTokenCount)} tokens`
  return expandable.value ? '展开查看摘要' : '摘要不在当前窗口内'
})
</script>

<template>
  <div class="compaction" :data-status="data.status">
    <button
      type="button"
      class="row"
      :disabled="!expandable"
      :aria-expanded="expandable ? open : undefined"
      @click="open = !open"
    >
      <span class="leading" aria-hidden="true">
        <span class="icon-context"><DsApi :size="14" /></span>
        <span class="icon-chevron" :data-open="open || undefined"
          ><DsChevronDown :size="14"
        /></span>
      </span>
      <span
        class="title"
        :class="{ 'ds-shimmer': data.status === 'running' }"
        data-tone="neutral"
        >{{ title }}</span
      >
      <template v-if="summary">
        <span class="sep" aria-hidden="true" />
        <span class="summary">{{ summary }}</span>
      </template>
    </button>
    <div v-if="open && expandable && data.summary" class="body">
      <ConversationMarkdown :text="data.summary" />
    </div>
  </div>
</template>

<style scoped>
.compaction {
  padding: var(--space-0-5) 0;
}

.row {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: var(--lh-base);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}

.row:not(:disabled) {
  cursor: pointer;
}

.row:not(:disabled):hover {
  background: var(--interactive-bg-hover);
}

.leading {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--space-4);
  height: var(--space-4);
  margin-right: var(--space-1-5);
  color: rgb(var(--label-secondary));
}

.icon-context,
.icon-chevron {
  display: inline-flex;
  grid-area: 1 / 1;
  transition: opacity var(--duration-ds-fast) ease;
}

.icon-chevron {
  opacity: 0;
  transform: rotate(-90deg);
}

.icon-chevron[data-open] {
  opacity: 1;
  transform: none;
}

.icon-chevron[data-open] ~ .icon-context,
.leading:has(.icon-chevron[data-open]) .icon-context {
  opacity: 0;
}

.row:not(:disabled):hover .icon-context {
  opacity: 0;
}

.row:not(:disabled):hover .icon-chevron {
  opacity: 1;
}

.title {
  flex: none;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  color: rgb(var(--label-tertiary));
}

[data-status='error'] .title {
  color: rgb(var(--danger));
}

.sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 var(--space-2);
  border-radius: 50%;
  background: rgb(var(--label-caption));
}

.summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  color: rgb(var(--label-tertiary));
}

.body {
  padding: var(--space-1) 0 var(--space-1)
    calc(var(--space-4) + var(--space-1-5));
  color: rgb(var(--label-tertiary));
}

.body :deep(.ds-md) {
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  color: rgb(var(--label-tertiary));
}
</style>
