<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { agentAncestry } from './environmentAgentsModel'
import {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
  type AgentView,
} from '@emperor/core/runtime-contract'
import {
  useAgentTree,
  agentLocation,
  visibleAgentChildren,
} from '../../sidebar/agentTree'
import Avatar from '../../ui/Avatar.vue'
import { abandonDelegation } from '../../../api/delegations'
const props = defineProps<{ rootSessionId: string; agents?: AgentView[] }>()
const route = useRoute()
const router = useRouter()
const model = useAgentTree()
const all = ref(false)
const readableRoot = computed(() =>
  props.rootSessionId && !/^(sub-|dlg-|dgr-|draft:)/.test(props.rootSessionId)
    ? props.rootSessionId
    : undefined,
)
const tree = computed(() =>
  readableRoot.value ? model.trees[readableRoot.value] : undefined,
)
const error = computed(() =>
  !props.agents && readableRoot.value
    ? model.errors[readableRoot.value]
    : undefined,
)
function refreshRoot() {
  if (readableRoot.value) void model.refresh(readableRoot.value)
}
const agents = computed(() => props.agents ?? tree.value?.agents ?? [])
const visible = computed(() => visibleAgentChildren(agents.value, all.value))
const active = computed(
  () =>
    agents.value.filter((a) => a.phase === 'running' || a.phase === 'waiting')
      .length,
)
watch(
  () => props.rootSessionId,
  (root) => {
    all.value = false
    if (root && !props.agents) refreshRoot()
  },
  { immediate: true },
)
const currentId = computed(() =>
  route.name === 'external-agent'
    ? route.params.delegationId
    : route.params.sessionId,
)
// Reveal direct links to older entries once; later refreshes respect manual collapse.
watch(
  () =>
    agents.value.some((agent) => agent.id === currentId.value)
      ? `${props.rootSessionId}:${currentId.value}`
      : '',
  (selection) => {
    if (
      selection &&
      !visibleAgentChildren(agents.value, false).some(
        (agent) => agent.id === currentId.value,
      )
    )
      all.value = true
  },
  { immediate: true },
)
function ancestry(agent: AgentView) {
  return agentAncestry(props.rootSessionId, agent, agents.value)
}
/** 「标记为已结束」 for an external task whose run has no outcome (AGT-04). */
const ending = ref<string | null>(null)
const endError = ref('')
async function end(agent: AgentView) {
  if (ending.value || !readableRoot.value) return
  ending.value = agent.id
  endError.value = ''
  try {
    await abandonDelegation({ id: agent.id, sessionId: readableRoot.value })
  } catch (cause) {
    endError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    ending.value = null
    refreshRoot()
  }
}
</script>
<template>
  <section
    v-if="agents.length || error"
    class="agents-section"
    data-section="subagents"
  >
    <h3>
      子智能体 <span v-if="active">{{ active }} 个活动中</span>
    </h3>
    <div v-for="agent in visible" :key="agent.id" class="agent-entry">
      <button
        type="button"
        class="agent-row"
        :data-agent-id="agent.id"
        :title="ancestry(agent).text"
        :aria-current="currentId === agent.id ? 'page' : undefined"
        @click="router.push(agentLocation(agent))"
      >
        <Avatar
          kind="sprite"
          v-if="agent.backend === 'internal'"
          :id="agent.id"
          :size="28"
        />
        <Avatar
          kind="logo"
          v-else
          :icon-id="agent.backend"
          :label="agentSourceLabel(agent.backend)"
          :size="16"
          :data-agent-logo="agent.backend"
        />
        <span class="agent-copy"
          ><strong>{{ agentTitle(agent.title, agent.backend) }}</strong
          ><small>{{ agentSourceLabel(agent.backend) }}</small
          ><small v-if="ancestry(agent).unavailable" data-unavailable-parent>{{
            ancestry(agent).unavailable
          }}</small></span
        >
        <span class="agent-phase">{{ agentPhaseLabel(agent.phase) }}</span>
      </button>
      <button
        v-if="agent.needsExit && readableRoot"
        type="button"
        class="agent-end"
        :data-abandon-agent="agent.id"
        title="这次运行没有正常结束。确认不再需要后，标记为已结束会释放它占用的工作区，Goal 可以继续。"
        :disabled="ending !== null"
        @click="end(agent)"
      >
        {{ ending === agent.id ? '正在结束…' : '标记为已结束' }}
      </button>
    </div>
    <p v-if="endError" class="agents-error" role="alert">{{ endError }}</p>
    <p v-if="error" class="agents-error" role="alert">
      {{ error }}
      <button
        type="button"
        class="agent-more"
        data-retry-agents
        @click="refreshRoot"
      >
        重试
      </button>
    </p>
    <button
      v-if="agents.length > 5"
      type="button"
      class="agent-more"
      data-show-all-agents
      :aria-expanded="all"
      @click="all = !all"
    >
      {{ all ? '收起' : '显示全部子智能体' }}
    </button>
  </section>
</template>
<style scoped>
.agents-section {
  padding: var(--space-1) var(--space-2);
  border-top: 1px solid var(--border-l1);
}
.agents-error {
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
}
h3 {
  margin: 0 0 var(--space-1);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  font-weight: 500;
}
h3 span {
  margin-left: var(--space-2);
}
.agent-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1-5) var(--space-1);
  border-radius: var(--radius-row);
  border: 0;
  background: transparent;
  color: rgb(var(--label-secondary));
  text-align: left;
  cursor: pointer;
}
.agent-row:hover,
.agent-row[aria-current='page'] {
  background: var(--interactive-bg-hover);
}
.agent-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.agent-copy strong,
.agent-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-copy strong {
  font-weight: 500;
  font-size: var(--fs-xs);
}
.agent-copy small,
.agent-phase,
.agent-more {
  font-size: var(--fs-xxs);
  color: rgb(var(--label-tertiary));
}
.agent-phase {
  flex: none;
}
.agent-end {
  display: block;
  margin: 0 0 var(--space-1) calc(28px + var(--space-3));
  padding: var(--space-0-5) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  cursor: pointer;
}
.agent-end:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}
.agent-end:disabled {
  cursor: default;
  opacity: 0.6;
}
.agent-more {
  padding: var(--space-1) 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
</style>
