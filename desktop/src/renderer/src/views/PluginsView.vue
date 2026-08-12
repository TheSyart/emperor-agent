<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SkillsPanel from '../components/panels/SkillsPanel.vue'
import ToolsPanel from '../components/panels/ToolsPanel.vue'
import McpPanel from '../components/panels/McpPanel.vue'
import PluginsPanel from '../components/panels/PluginsPanel.vue'
import { useAppContext } from '../composables/useAppContext'
import { actionIcons } from '../icons'

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()

type PluginTab = 'plugins' | 'skills' | 'tools' | 'mcp'

const activeTab = computed<PluginTab>(() => {
  const raw = Array.isArray(route.params.tab)
    ? route.params.tab[0]
    : route.params.tab
  if (raw === 'skills' || raw === 'tools' || raw === 'mcp') return raw
  return 'plugins'
})

watch(
  () => route.query.skill,
  (raw) => {
    const name = Array.isArray(raw) ? raw[0] : raw
    if (!name || activeTab.value !== 'skills') return
    if (ctx.activeSkill.value === name) return
    void ctx.runSafely(() => ctx.loadSkill(name))
  },
  { immediate: true },
)

watch(
  activeTab,
  (tab) => {
    if (tab === 'mcp' && !ctx.mcpContent.value) {
      void ctx.runSafely(() => ctx.loadMcpConfig())
    }
  },
  { immediate: true },
)

function switchTab(tab: PluginTab) {
  void router.push({ name: 'plugins', params: { tab } })
}

function onLoad(name: string) {
  void router.push({
    name: 'plugins',
    params: { tab: 'skills' },
    query: { skill: name },
  })
}

function onNew(name: string) {
  ctx.startNewSkill(name)
  void router.push({
    name: 'plugins',
    params: { tab: 'skills' },
    query: { skill: name },
  })
}

function onSave(content: string) {
  void ctx.runSafely(() => ctx.saveSkill(content))
}

function onDelete(name: string) {
  void ctx.runSafely(() => ctx.deleteSkill(name))
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>插件</h1>
        <p>Plugin 管理版本化扩展；裸 Skill 仍是普通文件</p>
      </div>
      <div class="plugins-head-actions">
        <div class="segmented-control">
          <button
            :class="{ active: activeTab === 'plugins' }"
            @click="switchTab('plugins')"
          >
            Plugin
          </button>
          <button
            :class="{ active: activeTab === 'skills' }"
            @click="switchTab('skills')"
          >
            技能
          </button>
          <button
            :class="{ active: activeTab === 'tools' }"
            @click="switchTab('tools')"
          >
            工具
          </button>
          <button
            :class="{ active: activeTab === 'mcp' }"
            @click="switchTab('mcp')"
          >
            MCP
          </button>
        </div>
        <button
          class="tool-button asset-button refresh-action"
          title="刷新"
          @click="ctx.refreshAll()"
        >
          <component :is="actionIcons.refresh" class="action-icon" :size="16" />
          <span>刷新</span>
        </button>
      </div>
    </header>
    <div class="view-body view-body-fill">
      <SkillsPanel
        v-if="activeTab === 'skills'"
        :skills="ctx.boot.value?.skills || []"
        :active-skill="ctx.activeSkill.value"
        :content="ctx.skillContent.value"
        @load="onLoad"
        @new="onNew"
        @save="onSave"
        @delete="onDelete"
      />
      <PluginsPanel
        v-else-if="activeTab === 'plugins'"
        :plugins="ctx.boot.value?.plugins || []"
        @changed="ctx.refreshAll()"
      />
      <ToolsPanel
        v-else-if="activeTab === 'tools'"
        :tools="ctx.boot.value?.tools || []"
      />
      <McpPanel v-else />
    </div>
  </section>
</template>
