<script setup lang="ts">
import { computed } from 'vue'
import type { AgentView } from '@emperor/core/api'
import { visibleAgentChildren, type AgentTreeStore } from './agentTree'
import SidebarAgentRow from './SidebarAgentRow.vue'

const props = defineProps<{
  store: AgentTreeStore
  rootId: string
  parentId: string
  selectedId: string
}>()
const emit = defineEmits<{ open: [agent: AgentView] }>()
const tree = computed(() => props.store.trees[props.rootId])
const children = computed(() => tree.value?.children[props.parentId] ?? [])
const visible = computed(() =>
  visibleAgentChildren(
    children.value,
    Boolean(props.store.showAll[props.parentId]),
  ),
)
</script>

<template>
  <div
    v-if="store.expanded[parentId]"
    class="agent-branch"
    role="group"
    aria-label="子智能体"
  >
    <template v-for="agent in visible" :key="agent.id">
      <SidebarAgentRow
        :agent="agent"
        :selected="selectedId === agent.id"
        :expandable="Boolean(tree?.children[agent.id]?.length)"
        :expanded="Boolean(store.expanded[agent.id])"
        @toggle="store.toggle(agent.id)"
        @open="emit('open', agent)"
      />
      <SidebarAgentTree
        :store="store"
        :root-id="rootId"
        :parent-id="agent.id"
        :selected-id="selectedId"
        @open="emit('open', $event)"
      />
    </template>
    <button
      type="button"
      v-if="children.length > 5"
      class="show-all"
      :aria-expanded="Boolean(store.showAll[parentId])"
      @click="store.toggleShowAll(parentId)"
    >
      {{
        store.showAll[parentId]
          ? '收起较早的子智能体'
          : `显示全部 ${children.length} 个子智能体`
      }}
    </button>
    <template v-if="parentId === rootId">
      <div
        v-if="tree?.unavailable.length"
        class="unavailable-group"
        role="group"
        aria-label="父级不可用的子智能体"
      >
        <div class="unavailable-heading">父级不可用</div>
        <template
          v-for="agent in visibleAgentChildren(
            tree.unavailable,
            Boolean(store.showAll[rootId]),
          )"
          :key="agent.id"
        >
          <SidebarAgentRow
            :agent="agent"
            :selected="selectedId === agent.id"
            :expandable="Boolean(tree.children[agent.id]?.length)"
            :expanded="Boolean(store.expanded[agent.id])"
            unavailable
            @toggle="store.toggle(agent.id)"
            @open="emit('open', agent)"
          />
          <SidebarAgentTree
            :store="store"
            :root-id="rootId"
            :parent-id="agent.id"
            :selected-id="selectedId"
            @open="emit('open', $event)"
          />
        </template>
        <button
          v-if="tree.unavailable.length > 5"
          type="button"
          class="show-all"
          @click="store.toggleShowAll(rootId)"
        >
          {{
            store.showAll[rootId]
              ? '收起较早的子智能体'
              : `显示全部 ${tree.unavailable.length} 个父级不可用的子智能体`
          }}
        </button>
      </div>
      <button
        type="button"
        v-if="store.errors[rootId]"
        class="retry"
        @click="store.refresh(rootId)"
      >
        {{ store.errors[rootId] }}，重试
      </button>
    </template>
  </div>
</template>

<style scoped>
.agent-branch {
  margin-left: var(--space-4);
  border-left: 1px solid var(--border-l1);
  padding-left: var(--space-1);
}
.show-all,
.retry {
  padding: var(--space-1) var(--space-2) var(--space-1-5)
    calc(var(--space-5) + 2px);
  border: none;
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  cursor: pointer;
  text-align: left;
}
.show-all:hover,
.retry:hover {
  color: rgb(var(--label-primary));
}
.unavailable-heading {
  padding: var(--space-1) var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
}
</style>
