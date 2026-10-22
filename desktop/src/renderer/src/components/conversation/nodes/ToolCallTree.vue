<script setup lang="ts">
/**
 * ToolCallTree — one root tool call plus its nested activity (dsh
 * ToolCallTree): the row, then an indented, left-ruled sub list for the
 * workflow run panel and the approval escalations raised by the call.
 *
 * A call that starts or continues a subagent (local, Claude Code, Codex)
 * is that subagent's one row (UI-S14, SubagentRow): face, name, source,
 * status and time, its whole width opening the child — 「/chat/<child>」
 * for a local one, the run page for Claude Code / Codex, with 任务详情
 * beside it. Its approvals, grants and workspace waits stay indented
 * under it; the child's transcript is never inlined.
 *
 * Props: node (tool), agentVariant ('single' in the flow, 'grouped'),
 * step (a step of a process group; false for a subagent row of its own).
 */
import { computed, defineAsyncComponent, inject, ref } from 'vue'
import { routerKey } from 'vue-router'
import type { ToolChatNode, ToolGrantView } from '../../../conversation/types'
import { DsShieldAlert } from '../../icons/ds'
import { useChatContext } from '../chatContext'
import {
  isDelegationCall,
  subagentAgentId,
  subagentHref,
  subagentRowOf,
} from '../subagentRows'
import { nativeAgentTarget } from '../tools/toolModel'
import { useAgentTree } from '../../sidebar/agentTree'
import SubagentRow from './SubagentRow.vue'
import ToolCallRow from './ToolCallRow.vue'
import WorkflowRunPanel from './WorkflowRunPanel.vue'
import WorkspaceWaitLine from './WorkspaceWaitLine.vue'
import { workspaceWaitFor } from './workspaceWaits'

const props = withDefaults(
  defineProps<{
    node: ToolChatNode
    agentVariant?: 'single' | 'grouped'
    step?: boolean
  }>(),
  { agentVariant: 'grouped', step: true },
)
const chat = useChatContext()
const { actions } = chat
const router = inject(routerKey, undefined)
const data = computed(() => props.node.data)
const owner = computed(() => chat.rootSessionId?.() ?? chat.sessionId())
const agentTree = useAgentTree()
/** A continued local child (send_message) the root's agent list knows. */
const nativeAgent = computed(() => {
  const id = nativeAgentTarget(data.value)
  const agent = id ? agentTree.trees[owner.value]?.byId[id] : undefined
  return agent?.kind === 'internal' &&
    agent.backend === 'internal' &&
    agent.rootSessionId === owner.value
    ? agent
    : undefined
})
/** The agent list's view of this call's subagent (the card's source). */
const listed = computed(() => {
  const id = subagentAgentId(data.value)
  const agent = id ? agentTree.trees[owner.value]?.byId[id] : undefined
  return agent?.rootSessionId === owner.value ? agent : undefined
})
const isAgent = computed(
  () =>
    isDelegationCall(data.value) ||
    data.value.externalAgent !== undefined ||
    nativeAgent.value !== undefined,
)
const row = computed(() => subagentRowOf(data.value, listed.value))
const href = computed(() => subagentHref(row.value, owner.value))
const detailsRun = ref<{ runId: string; delegationId: string } | null>(null)
const ExternalAgentDetails = defineAsyncComponent(
  () => import('../environment/ExternalAgentDetails.vue'),
)

function openAgent(event: MouseEvent) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const id = row.value.agentId
  if (id === undefined) return
  if (row.value.backend !== 'internal') {
    if (!router) return
    event.preventDefault()
    void router.push({
      name: 'external-agent',
      params: { sessionId: owner.value, delegationId: id },
    })
  } else {
    event.preventDefault()
    actions.openSubagent(id)
  }
}

function openDetails() {
  const run = row.value.run
  if (run) detailsRun.value = { ...run }
}

const APPROVAL_LABEL: Record<string, string> = {
  'allowed-once': '已允许',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法审批',
}

const GRANT_LABEL: Record<string, string> = {
  once: '已允许本次',
  task: '本任务内允许',
  session: '本会话内允许',
  timed: '限时允许',
  denied: '已拒绝',
}

function grantStatus(grant: ToolGrantView): string {
  if (grant.decision === undefined) return '等待决定'
  if (grant.cause !== undefined && grant.cause !== 'user') return '已取消'
  return GRANT_LABEL[grant.decision] ?? grant.decision
}

/** This call's write waits for a subagent's workspace (AGT-06). */
const wait = workspaceWaitFor(props.node.data.callId)

const hasChildren = computed(
  () =>
    wait.value !== undefined ||
    data.value.workflow !== undefined ||
    data.value.approvals.length > 0 ||
    (data.value.grants?.length ?? 0) > 0,
)
</script>

<template>
  <div
    class="tool-call"
    :data-process-step="step ? '' : undefined"
    :data-chat-call-id="data.callId"
    :data-agent="isAgent || undefined"
  >
    <SubagentRow
      v-if="isAgent"
      :row="row"
      :href="href"
      :variant="agentVariant"
      :details="Boolean(data.externalAgent)"
      @open="openAgent"
      @details="openDetails"
    />
    <ToolCallRow v-else :data="data" :agent="nativeAgent" />
    <div v-if="hasChildren" class="subcalls" data-subcalls>
      <WorkspaceWaitLine v-if="wait" :wait="wait" />
      <div
        v-for="approval in data.approvals"
        :key="approval.id"
        class="sub-line"
        :data-outcome="approval.outcome ?? 'pending'"
      >
        <span class="sub-leading"><DsShieldAlert :size="14" /></span>
        <span class="sub-title">审批</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="sub-text">{{ approval.reason ?? approval.toolName }}</span>
        <span class="sub-status">{{
          approval.outcome === undefined
            ? '等待决定'
            : (APPROVAL_LABEL[approval.outcome] ?? approval.outcome)
        }}</span>
      </div>
      <div
        v-for="grant in data.grants ?? []"
        :key="grant.id"
        class="sub-line"
        data-grant
        :data-outcome="
          grant.decision === undefined
            ? 'pending'
            : grant.decision === 'denied'
              ? 'rejected'
              : grant.cause && grant.cause !== 'user'
                ? 'cancelled'
                : 'allowed-once'
        "
      >
        <span class="sub-leading"><DsShieldAlert :size="14" /></span>
        <span class="sub-title">{{
          grant.highImpact ? '高影响操作确认' : '电脑操作授权'
        }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="sub-text">{{ grant.target }}</span>
        <span class="sub-status">{{ grantStatus(grant) }}</span>
      </div>
      <WorkflowRunPanel
        v-if="data.workflow"
        :run="data.workflow"
        :expansion-key="`workflow:${data.callId}`"
      />
    </div>
    <ExternalAgentDetails
      v-if="detailsRun"
      :run-id="detailsRun.runId"
      :delegation-id="detailsRun.delegationId"
      :session-id="owner"
      @close="detailsRun = null"
      @root="router?.push({ name: 'chat', params: { sessionId: owner } })"
      @configure="
        router?.push({
          query: { ...router.currentRoute.value.query, settings: 'executors' },
        })
      "
    />
  </div>
</template>

<style scoped>
.tool-call {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--r-sm);
}

.subcalls {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0 0 var(--space-0-5) calc(var(--space-4) + var(--space-1-5));
  padding-left: var(--space-2);
  border-left: 1px solid var(--stroke-2);
}

/* Under a subagent row: indented to its name. */
[data-agent] > .subcalls {
  margin-left: calc(var(--space-2) + var(--space-2-5));
}

.sub-line {
  display: flex;
  align-items: center;
  min-width: 0;
  height: var(--control-sm);
  font: var(--type-footnote) var(--font-sans);
}

.sub-leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  margin-right: var(--space-1-5);
  color: rgb(var(--text-3));
}

[data-outcome='pending'] .sub-leading {
  color: rgb(var(--attention));
}

.sub-title {
  flex: none;
  color: rgb(var(--text-2));
}

.sep {
  flex: none;
  margin: 0 var(--space-1-5);
  color: rgb(var(--text-4));
}

.sub-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--text-3));
}

.sub-status {
  flex: none;
  margin-left: var(--space-2);
  font-size: var(--fs-xs);
  color: rgb(var(--text-2));
}
</style>
