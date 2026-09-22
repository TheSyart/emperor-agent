<script setup lang="ts">
/**
 * FallbackRow — the rest of the turn moved to the fallback route: one dim
 * 13/20 line (`已切换到备用模型 backup · 限流`) with a details disclosure
 * naming the failure that triggered it.
 */
import { computed } from 'vue'
import type { FallbackChatNode } from '../../../conversation/types'
import { useExpansion } from '../chatContext'

const props = defineProps<{ node: FallbackChatNode }>()
const open = useExpansion(() => `${props.node.key}:details`)

const TRIGGER_LABEL: Record<string, string> = {
  rate_limit: '限流',
  transient: '临时故障',
}
const trigger = computed(
  () =>
    TRIGGER_LABEL[String(props.node.data.trigger)] ??
    String(props.node.data.trigger),
)
</script>

<template>
  <div class="fallback">
    <button
      type="button"
      class="summary"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span role="status"
        >已切换到备用模型 {{ node.data.to }} · {{ trigger }}</span
      >
      <span class="chevron" :data-open="open || undefined" aria-hidden="true" />
    </button>
    <div v-if="open" class="details">
      <div><span class="label">原模型</span>{{ node.data.from }}</div>
      <div>
        <span class="label">失败原因</span>{{ node.data.message }}
        <code v-if="node.data.code" class="code">{{ node.data.code }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fallback {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-0-5) 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.summary:hover {
  color: rgb(var(--label-secondary));
}

.chevron {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: 0.8;
  transform: rotate(-45deg);
  transition: transform var(--duration-fast) ease;
}

.chevron[data-open] {
  transform: rotate(45deg);
}

.details {
  display: grid;
  gap: var(--space-0-5);
  margin-top: var(--space-1);
  padding-left: var(--space-3-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.label {
  margin-right: var(--space-1-5);
  color: rgb(var(--label-secondary));
}

.code {
  margin-left: var(--space-1-5);
  font: var(--font-code-small);
}
</style>
