<script setup lang="ts">
import { agentTitle, agentSourceLabel } from '@emperor/core/api'
import { computed, nextTick, ref, watch } from 'vue'
import type { ToolExternalAgentView } from '../../../conversation/types'
import { provideDelegationLinks } from '../delegationLinks'
import { useChatContext, useExpansion } from '../chatContext'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'
import StateDot from '../../ui/StateDot.vue'
import ProviderLogo from '../../ui/ProviderLogo.vue'
const props = defineProps<{ run: ToolExternalAgentView; callId: string }>()
const chat = useChatContext()
const { click, links } = provideDelegationLinks(() => ({
  sessionId: chat.rootSessionId?.() ?? chat.sessionId(),
  delegationId: props.run.delegationId,
}))
const live = computed(() =>
  ['queued', 'preparing', 'running', 'waiting_input', 'cancelling'].includes(
    props.run.phase,
  ),
)
const open = useExpansion(
  () => `external:${props.callId}`,
  () => live.value,
)
const labels: Record<string, string> = {
  queued: '等待调度',
  preparing: '正在准备',
  running: '执行中',
  waiting_input: '等待回答',
  cancelling: '正在停止',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  outcome_unknown: '结果待确认',
}
const label = computed(() => labels[props.run.phase] ?? props.run.phase)
// Files may appear after their first mention, including a run with no further text.
watch([() => props.run.runId, () => props.run.phase], () => links.refresh())
const content = ref<HTMLElement | null>(null)
watch(
  () => [props.run.text, props.run.activity.length],
  async () => {
    const el = content.value
    const following =
      el && el.scrollHeight - el.clientHeight - el.scrollTop < 64
    await nextTick()
    if (following && content.value === el) el.scrollTop = el.scrollHeight
  },
)
</script>
<template>
  <section
    class="external-stream"
    @click.capture="click"
    data-external-agent-stream
    :data-run-id="run.runId"
    :data-phase="run.phase"
  >
    <button
      type="button"
      class="stream-toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ProviderLogo
        :icon-id="run.backend"
        :label="agentSourceLabel(run.backend)"
        size="xs"
        :data-agent-logo="run.backend"
      />
      <StateDot
        :state="live ? 'ongoing' : run.phase === 'completed' ? 'ok' : 'warn'"
      />
      <strong>{{ agentTitle(run.title, run.backend) }}</strong>
      <span>{{ agentSourceLabel(run.backend) }}</span>
      <span>{{ label }}</span
      ><span class="stream-expand">{{ open ? '收起过程' : '查看过程' }}</span>
    </button>
    <div v-if="open" ref="content" class="stream-content">
      <p v-if="run.truncated" class="stream-note">
        显示最近的输出，更多过程可打开子智能体查看。
      </p>
      <ConversationMarkdown
        v-if="run.text"
        :text="run.text"
        :streaming="live"
      />
      <p v-else-if="live" class="stream-note">等待执行器输出…</p>
      <ol v-if="run.activity.length" class="stream-tools">
        <li v-for="(tool, index) in run.activity" :key="index">
          <span>{{
            tool.status === 'running'
              ? '开始'
              : tool.status === 'failed'
                ? '失败'
                : '结束'
          }}</span>
          <code>{{ tool.name }}</code
          ><span v-if="tool.detail">{{ tool.detail }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>
<style scoped>
.external-stream {
  min-width: 0;
  border-left: 1px solid var(--border-l1);
  padding-left: var(--space-3);
}
.stream-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  color: rgb(var(--label-secondary));
  font: var(--font-code-small);
  cursor: pointer;
}
.stream-toggle strong {
  font-weight: 500;
}
.stream-expand {
  margin-left: auto;
  color: rgb(var(--label-caption));
}
.stream-content {
  max-height: 360px;
  overflow: auto;
  padding: var(--space-3) 0;
  overflow-wrap: anywhere;
}
.stream-content :deep(.ds-md) {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
.stream-tools {
  list-style: none;
  padding: 0;
  margin: var(--space-3) 0 0;
  font: var(--font-code-small);
}
.stream-tools li {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  color: rgb(var(--label-secondary));
}
.stream-tools li > span:first-child,
.stream-note {
  color: rgb(var(--label-caption));
}
.stream-tools li > span:first-child,
.stream-tools code {
  flex: none;
}
.stream-tools li > span:last-child {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
