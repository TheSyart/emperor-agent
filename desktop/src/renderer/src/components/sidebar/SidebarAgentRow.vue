<script setup lang="ts">
import { computed } from 'vue'
import {
  agentPhaseLabel,
  agentSourceLabel,
  agentTitle,
  type AgentView,
} from '@emperor/core/runtime-contract'
import BrandMark from '../brand/BrandMark.vue'
import ProviderLogo from '../ui/ProviderLogo.vue'
import { DsChevronRight } from '../icons/ds'

const props = withDefaults(
  defineProps<{
    agent: AgentView
    selected: boolean
    expandable?: boolean
    expanded?: boolean
    unavailable?: boolean
  }>(),
  { expandable: false, expanded: false, unavailable: false },
)
const emit = defineEmits<{ open: []; toggle: [] }>()
const title = computed(() => agentTitle(props.agent.title, props.agent.backend))
</script>

<template>
  <div
    class="agent-row"
    :data-selected="selected || undefined"
    :data-agent-id="agent.id"
  >
    <button
      type="button"
      v-if="expandable"
      class="expander"
      :aria-label="`${expanded ? '收起' : '展开'} ${title} 的子智能体`"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <DsChevronRight :size="12" :class="{ expanded }" />
    </button>
    <span v-else class="expander-space" />
    <button
      type="button"
      class="agent-open"
      :aria-current="selected ? 'page' : undefined"
      :title="`${title} · ${agentSourceLabel(agent.backend)} · ${agentPhaseLabel(agent.phase)}`"
      @click="emit('open')"
    >
      <BrandMark v-if="agent.backend === 'internal'" :size="16" />
      <ProviderLogo
        v-else
        :icon-id="agent.backend"
        :label="agentSourceLabel(agent.backend)"
        size="xs"
      />
      <span class="agent-copy">
        <span class="agent-title">{{ title }}</span>
        <span class="agent-meta"
          ><span class="source">{{ agentSourceLabel(agent.backend) }}</span
          ><span class="phase" :data-phase="agent.phase">{{
            agentPhaseLabel(agent.phase)
          }}</span></span
        >
        <span v-if="unavailable" class="unavailable"
          >父级不可用 · {{ agent.parentAgentId }}</span
        >
      </span>
    </button>
  </div>
</template>

<style scoped>
.agent-row {
  display: flex;
  align-items: flex-start;
  min-width: 0;
  border-radius: var(--radius-row);
}
.agent-row:hover {
  background: var(--interactive-bg-hover);
}
.agent-row[data-selected] {
  background: var(--interactive-bg-active);
  box-shadow: inset 2px 0 0 rgb(var(--label-primary) / 0.5);
}
.expander,
.expander-space {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 30px;
}
button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.expander {
  padding: 0;
  color: rgb(var(--label-tertiary));
}
.expanded {
  transform: rotate(90deg);
}
.agent-open {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: var(--space-1-5);
  min-width: 0;
  padding: var(--space-1-5) var(--space-2) var(--space-1-5) 0;
  text-align: left;
}
.agent-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.agent-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  line-height: 16px;
}
.agent-row[data-selected] .agent-title {
  font-weight: 500;
}
.agent-meta {
  display: flex;
  gap: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}
.phase[data-phase='running'] {
  color: rgb(var(--label-primary));
}
.phase[data-phase='waiting'],
.phase[data-phase='failed'],
.unavailable {
  color: rgb(var(--label-secondary));
}
.unavailable {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xxs);
}
button:focus-visible {
  outline: 2px solid rgb(var(--focus-ring) / 0.5);
  border-radius: var(--radius-xs);
}
</style>
