<script setup lang="ts">
/**
 * 能力 › 工具 — native section: Emperor's own tools, grouped by what they
 * are for (Core's `category`: 基础工具 · 网络 · 任务与规划 · 子代理与工作流 ·
 * 技能、记忆与配置, then 其他), each group title with its count. A row is a
 * compact disclosure (ToolRow: name and one sentence; expanded: traits,
 * parameters and the JSON schema). A search field filters by name and
 * description. MCP servers' tools are on the MCP tab and a plugin's tools
 * in its detail; the lead-in links there. Refresh reloads the list from
 * Core (`skills.tools`) into the bootstrap state.
 */
import Badge from '../ui/Badge.vue'
import LinkButton from '../ui/LinkButton.vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { ToolInfo } from '../../types'
import { onPageReactivated } from '../pages/pageLifecycle'
import ToolRow from './tools/ToolRow.vue'
import { groupTools, isBuiltinTool, toolMatches } from './tools/toolSchema'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { EmptyState, SearchField, SettingsGroup, SettingsSection } from './ui'

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()

const tools = computed<ToolInfo[]>(() =>
  (ctx.boot.value?.tools ?? []).filter(isBuiltinTool),
)
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

/** Another 能力 tab, like its tab button (the open Skill or plugin stays behind). */
function openTab(tab: 'mcp' | 'plugins'): void {
  const { skill: _skill, plugin: _plugin, scope: _scope, ...rest } = route.query
  void router
    .replace({
      path: tab === 'plugins' ? '/capabilities' : '/capabilities/mcp',
      query: rest,
    })
    .catch(() => undefined)
}
</script>

<template>
  <SettingsSection>
    <template #intro>
      这里是 Emperor 内建的工具；MCP 服务器的工具见
      <LinkButton data-link="mcp" @click="openTab('mcp')">MCP</LinkButton
      >，插件的工具见
      <LinkButton data-link="plugins" @click="openTab('plugins')"
        >插件</LinkButton
      >。
    </template>
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
      description="Agent 启动后会在这里列出内建工具。"
      framed
    />
    <EmptyState
      v-else-if="!filtered.length"
      title="没有匹配的工具"
      variant="inline"
    />
    <SettingsGroup
      v-for="group in groups"
      :key="group.id"
      plain
      :data-group="group.id"
    >
      <template #title>
        {{ group.title }}
        <Badge
          class="group-count"
          variant="count"
          :label="group.tools.length"
        />
      </template>
      <ul class="tool-list">
        <ToolRow
          v-for="tool in group.tools"
          :key="tool.name"
          :tool="tool"
          :open="open === tool.name"
          @update:open="(value: boolean) => (open = value ? tool.name : null)"
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

.count {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-regular);
  color: rgb(var(--text-3));
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
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-card);
  list-style: none;
}
</style>
