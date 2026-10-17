<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
  type AgentView,
} from '@emperor/core/api'
import {
  useAgentTree,
  agentLocation,
  visibleAgentChildren,
} from '../../sidebar/agentTree'
const props = defineProps<{ rootSessionId: string }>()
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
  readableRoot.value ? model.errors[readableRoot.value] : undefined,
)
function refreshRoot() {
  if (readableRoot.value) void model.refresh(readableRoot.value)
}
const agents = computed(() => tree.value?.agents ?? [])
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
    if (root) refreshRoot()
  },
  { immediate: true },
)
function ancestry(agent: AgentView): { text: string; unavailable?: string } {
  const parts = [agentTitle(agent.title, agent.backend)]
  const seen = new Set([agent.id])
  let current = agent
  function broken(label: string, id: string) {
    const unavailable = `${label} · ${id}${id !== agent.parentAgentId ? `（父级 ${agent.parentAgentId}）` : ''}`
    return { text: [unavailable, ...parts].join(' / '), unavailable }
  }
  while (true) {
    const id = current.parentAgentId
    if (
      ['missing_parent', 'foreign_parent', 'conflicting_parent'].includes(
        current.unavailable ?? '',
      )
    )
      return broken('父级不可用', id)
    if (current.unavailable === 'cyclic_parent') return broken('父级循环', id)
    if (seen.has(id)) return broken('父级循环', id)
    if (id === props.rootSessionId) {
      if (tree.value?.unavailable.some((row) => row.id === agent.id))
        return broken('父级不可用', agent.parentAgentId)
      return { text: ['主会话', ...parts].join(' / ') }
    }
    const parent = tree.value?.byId[id]
    if (!parent || parent.rootSessionId !== props.rootSessionId)
      return broken('父级不可用', id)
    parts.unshift(agentTitle(parent.title, parent.backend))
    seen.add(id)
    current = parent
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
    <button
      v-for="agent in visible"
      :key="agent.id"
      type="button"
      class="agent-row"
      :data-agent-id="agent.id"
      :title="ancestry(agent).text"
      @click="router.push(agentLocation(agent))"
    >
      <span class="agent-copy"
        ><strong>{{ agentTitle(agent.title, agent.backend) }}</strong
        ><small
          >{{ agentSourceLabel(agent.backend) }} ·
          {{ ancestry(agent).text }}</small
        ><small v-if="ancestry(agent).unavailable" data-unavailable-parent>{{
          ancestry(agent).unavailable
        }}</small></span
      >
      <span class="agent-phase">{{ agentPhaseLabel(agent.phase) }}</span>
    </button>
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
  padding: var(--space-2) 0;
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
  padding: var(--space-1-5) 0;
  border: 0;
  background: transparent;
  color: rgb(var(--label-secondary));
  text-align: left;
  cursor: pointer;
}
.agent-row:hover {
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
.agent-more {
  padding: var(--space-1) 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
</style>
