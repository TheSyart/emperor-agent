<script setup lang="ts">
/**
 * 能力 › 工具 — native section: every tool registered for the Agent
 * (built-in first, then one group per MCP server) as compact disclosure rows
 * (ToolRow: name, read-only / writable badge, one-line description;
 * expanded: traits, parameters and the JSON schema). A search field filters
 * by name, description and server. Refresh reloads the list from Core
 * (`skills.tools`) into the bootstrap state.
 */
import { computed, ref } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { ToolInfo } from '../../types'
import { onPageReactivated } from '../pages/pageLifecycle'
import ToolRow from './tools/ToolRow.vue'
import { groupTools, toolMatches } from './tools/toolSchema'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { EmptyState, SearchField, SettingsGroup, SettingsSection } from './ui'

const ctx = useAppContext()

const tools = computed<ToolInfo[]>(() => ctx.boot.value?.tools ?? [])
const query = ref('')
const open = ref<string | null>(null)
const error = ref('')

const filtered = computed(() =>
  tools.value.filter((tool) => toolMatches(tool, query.value)),
)
const groups = computed(() => groupTools(filtered.value))

useSettingsHeader({
  actions: () => [refreshAction(() => reload(), { title: '刷新工具列表' })],
})
onPageReactivated(() => reload())

async function reload(): Promise<void> {
  error.value = ''
  try {
    const list = (await core('skills.tools')) as ToolInfo[]
    if (ctx.boot.value) ctx.boot.value.tools = list
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
</script>

<template>
  <SettingsSection>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <SearchField
      v-model="query"
      placeholder="筛选工具"
      aria-label="筛选工具"
      class="search"
    >
      <template #trailing>
        <span class="count">
          {{
            query
              ? `${filtered.length} / ${tools.length}`
              : `共 ${tools.length} 个`
          }}
        </span>
      </template>
    </SearchField>

    <EmptyState
      v-if="!tools.length"
      title="还没有注册的工具"
      description="Agent 启动后会在这里列出内建工具与 MCP 工具。"
    />
    <EmptyState
      v-else-if="!filtered.length"
      title="没有匹配的工具"
      variant="plain"
      compact
    />
    <SettingsGroup
      v-for="group in groups"
      :key="group.id"
      :data-group="group.id"
    >
      <template #title>
        {{ group.title }}
        <span class="group-count">{{ group.tools.length }}</span>
      </template>
      <ul class="tool-list">
        <ToolRow
          v-for="tool in group.tools"
          :key="`${group.id}:${tool.name}`"
          :tool="tool"
          :open="open === `${group.id}:${tool.name}`"
          @update:open="
            (value: boolean) =>
              (open = value ? `${group.id}:${tool.name}` : null)
          "
        />
      </ul>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.error {
  margin: 0 0 var(--space-3);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.search {
  margin-top: var(--space-1);
}

.count,
.group-count {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 400;
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.group-count {
  margin-left: var(--space-1-5);
}

.tool-list {
  display: flex;
  flex-direction: column;
  margin: var(--space-2) 0 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  list-style: none;
}
</style>
