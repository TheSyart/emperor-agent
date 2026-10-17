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
const tree = computed(() => model.trees[props.rootSessionId])
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
    if (root) void model.refresh(root)
  },
  { immediate: true },
)
function path(agent: AgentView): string {
  const parts = [agentTitle(agent.title, agent.backend)]
  const seen = new Set([agent.id])
  let parent = tree.value?.byId[agent.parentAgentId]
  while (parent && !seen.has(parent.id)) {
    parts.unshift(agentTitle(parent.title, parent.backend))
    seen.add(parent.id)
    parent = tree.value?.byId[parent.parentAgentId]
  }
  return ['主会话', ...parts].join(' / ')
}
</script>
<template>
  <section v-if="agents.length" class="agents-section" data-section="subagents">
    <h3>
      子智能体 <span v-if="active">{{ active }} 个活动中</span>
    </h3>
    <button
      v-for="agent in visible"
      :key="agent.id"
      type="button"
      class="agent-row"
      :data-agent-id="agent.id"
      :title="path(agent)"
      @click="router.push(agentLocation(agent))"
    >
      <span class="agent-copy"
        ><strong>{{ agentTitle(agent.title, agent.backend) }}</strong
        ><small
          >{{ agentSourceLabel(agent.backend) }} · {{ path(agent) }}</small
        ></span
      >
      <span class="agent-phase">{{ agentPhaseLabel(agent.phase) }}</span>
    </button>
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
