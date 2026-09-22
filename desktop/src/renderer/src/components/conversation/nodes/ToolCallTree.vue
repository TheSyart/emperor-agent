<script setup lang="ts">
/**
 * ToolCallTree — one root tool call plus its nested activity (dsh
 * ToolCallTree): the row, then an indented, left-ruled sub list for the
 * workflow run panel, the delegated child's status line (never its
 * transcript — "打开子会话" opens the child session) and approval
 * escalations raised by the call.
 *
 * Props: node (tool).
 */
import { computed } from 'vue'
import type { ToolChatNode } from '../../../conversation/types'
import { DsChevronRight, DsShieldAlert } from '../../icons/ds'
import StateDot from '../../ui/StateDot.vue'
import type { StateDotState } from '../../ui/stateDot'
import { useChatContext } from '../chatContext'
import { subagentStatusLabel } from '../tools/registry'
import { lastLine } from '../tools/toolModel'
import ToolCallRow from './ToolCallRow.vue'
import WorkflowRunPanel from './WorkflowRunPanel.vue'

const props = defineProps<{ node: ToolChatNode }>()
const { actions } = useChatContext()
const data = computed(() => props.node.data)

const subagentDot = computed<StateDotState>(() => {
  const sub = data.value.subagent
  if (sub === undefined || sub.status === 'running') return 'ongoing'
  switch (sub.stopReason) {
    case 'completed':
    case undefined:
      return 'ok'
    case 'error':
    case 'refusal':
      return 'error'
    default:
      return 'warn'
  }
})
const subagentLine = computed(() => {
  const sub = data.value.subagent
  if (sub === undefined) return ''
  if (sub.text !== undefined && sub.text.trim() !== '')
    return lastLine(sub.text).replace(/[`*_#>]/gu, '')
  return sub.status === 'running' ? '正在处理…' : ''
})

const APPROVAL_LABEL: Record<string, string> = {
  'allowed-once': '已允许',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法审批',
}

const hasChildren = computed(
  () =>
    data.value.workflow !== undefined ||
    data.value.subagent !== undefined ||
    data.value.approvals.length > 0,
)
</script>

<template>
  <div class="tool-call" :data-chat-call-id="data.callId">
    <ToolCallRow :data="data" />
    <div v-if="hasChildren" class="subcalls" data-subcalls>
      <div
        v-for="approval in data.approvals"
        :key="approval.id"
        class="sub-line"
        :data-outcome="approval.outcome ?? 'pending'"
      >
        <span class="sub-leading"><DsShieldAlert :size="14" /></span>
        <span class="sub-title">审批</span>
        <span class="sep" aria-hidden="true" />
        <span class="sub-text">{{ approval.reason ?? approval.toolName }}</span>
        <span class="sub-status">{{
          approval.outcome === undefined
            ? '等待决定'
            : (APPROVAL_LABEL[approval.outcome] ?? approval.outcome)
        }}</span>
      </div>
      <div
        v-if="data.subagent"
        class="sub-line"
        data-subagent-line
        :data-status="data.subagent.status"
      >
        <span class="sub-leading"><StateDot :state="subagentDot" /></span>
        <span class="sub-title">{{ subagentStatusLabel(data) }}</span>
        <template v-if="subagentLine">
          <span class="sep" aria-hidden="true" />
          <span class="sub-text">{{ subagentLine }}</span>
        </template>
        <button
          type="button"
          class="open-link"
          @click="actions.openSubagent(data.subagent.subagentId)"
        >
          打开子会话<DsChevronRight :size="12" />
        </button>
      </div>
      <WorkflowRunPanel
        v-if="data.workflow"
        :run="data.workflow"
        :expansion-key="`workflow:${data.callId}`"
      />
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--radius-sm);
}

.subcalls {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-1) 0 var(--space-0-5)
    calc(var(--space-4) + var(--space-1-5));
  padding-left: var(--space-2);
  border-left: 1px solid var(--border-l2);
}

.sub-line {
  display: flex;
  align-items: center;
  min-width: 0;
  height: var(--lh-base);
  font-size: var(--fs-s);
  line-height: var(--lh-base);
}

.sub-leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  margin-right: var(--space-1-5);
  color: rgb(var(--label-tertiary));
}

[data-outcome='pending'] .sub-leading {
  color: rgb(var(--approval));
}

.sub-title {
  flex: none;
  color: rgb(var(--label-secondary));
}

.sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 var(--space-2);
  border-radius: 50%;
  background: rgb(var(--label-caption));
}

.sub-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--label-tertiary));
}

.sub-status {
  flex: none;
  margin-left: var(--space-2);
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}

.open-link {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  margin-left: auto;
  padding: 0 0 0 var(--space-2);
  border: none;
  background: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--accent-strong));
  cursor: pointer;
}

.open-link:hover {
  text-decoration: underline;
}
</style>
