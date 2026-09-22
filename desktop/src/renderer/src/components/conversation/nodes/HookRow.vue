<script setup lang="ts">
/**
 * HookRow — one hook command invocation, collapsed:
 * `Hook · PreToolUse · Bash · 放行 · 12ms`; details show dialect, handler,
 * exit code and the stderr summary.
 */
import { computed } from 'vue'
import type { HookChatNode } from '../../../conversation/types'
import { DsCode } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import StateDot from '../../ui/StateDot.vue'
import { useExpansion } from '../chatContext'

const props = defineProps<{ node: HookChatNode }>()
const open = useExpansion(() => `${props.node.key}:body`)

const DECISION_LABEL: Record<string, string> = {
  pass: '放行',
  allow: '允许',
  deny: '拒绝',
  block: '阻止',
  ask: '询问',
  error: '出错',
}

const data = computed(() => props.node.data)
const blocked = computed(
  () =>
    data.value.decision === 'deny' ||
    data.value.decision === 'block' ||
    data.value.decision === 'error',
)
const summary = computed(() =>
  [
    data.value.point,
    data.value.matcher,
    data.value.status === 'running'
      ? '运行中'
      : data.value.decision === undefined
        ? undefined
        : (DECISION_LABEL[data.value.decision] ?? data.value.decision),
    data.value.durationMs === undefined
      ? undefined
      : `${data.value.durationMs}ms`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · '),
)
</script>

<template>
  <div class="hook-row">
    <DisclosureRow
      v-model:open="open"
      title="Hook"
      :summary="summary"
      :running="data.status === 'running'"
      :tone="blocked ? 'error' : 'default'"
    >
      <template #icon>
        <StateDot v-if="blocked" state="error" />
        <DsCode v-else :size="14" />
      </template>
      <dl class="facts">
        <dt>方言</dt>
        <dd>{{ data.dialect }}</dd>
        <dt>处理器</dt>
        <dd>{{ data.handlerId }}</dd>
        <template v-if="data.exitCode !== undefined">
          <dt>退出码</dt>
          <dd>{{ data.exitCode }}</dd>
        </template>
        <template v-if="data.stderrSummary">
          <dt>stderr</dt>
          <dd class="stderr-text">{{ data.stderrSummary }}</dd>
        </template>
      </dl>
    </DisclosureRow>
  </div>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-0-5) var(--space-3);
  margin: var(--space-1) 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

dt {
  color: rgb(var(--label-secondary));
}

dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.stderr-text {
  font-family: var(--font-mono);
  white-space: pre-wrap;
}
</style>
