<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { mcpServerCapability, toolCapability } from '../../capabilities/capabilityProjection'
import { useAppContext } from '../../composables/useAppContext'
import { actionIcons } from '../../icons'
import CapabilityCard from '../capabilities/CapabilityCard.vue'

const ctx = useAppContext()
const draft = ref('')
const parseError = ref('')

watch(() => ctx.mcpContent.value, (content) => {
  draft.value = content
  parseError.value = ''
}, { immediate: true })

onMounted(() => {
  if (!ctx.mcpContent.value) {
    void ctx.runSafely(() => ctx.loadMcpConfig())
  }
})

const parsed = computed(() => {
  if (!draft.value.trim()) return null
  try {
    return JSON.parse(draft.value) as Record<string, unknown>
  } catch {
    return null
  }
})

const serverCount = computed(() => {
  const servers = parsed.value?.servers as Record<string, unknown> | undefined
  return servers ? Object.keys(servers).length : 0
})

const enabledCount = computed(() => {
  const servers = parsed.value?.servers as Record<string, { enabled?: boolean }> | undefined
  if (!servers) return 0
  return Object.values(servers).filter((s) => s.enabled !== false).length
})

const mcpTools = computed(() => ctx.boot.value?.tools?.filter((t) => t.source === 'mcp') || [])
const serverItems = computed(() => {
  const servers = parsed.value?.servers as Record<string, unknown> | undefined
  if (!servers) return []
  return Object.entries(servers).map(([name, config]) => {
    const toolCount = mcpTools.value.filter((tool) => tool.server === name).length
    return mcpServerCapability(name, config as any, toolCount)
  })
})
const mcpToolItems = computed(() => mcpTools.value.map((tool) => toolCapability(tool)))

function validate() {
  parseError.value = ''
  if (!draft.value.trim()) return true
  try {
    JSON.parse(draft.value)
    return true
  } catch (e) {
    parseError.value = e instanceof Error ? e.message : 'JSON 格式错误'
    return false
  }
}

function save() {
  if (!validate()) return
  void ctx.runSafely(() => ctx.saveMcpConfig(draft.value))
}

function formatJson() {
  try {
    const obj = JSON.parse(draft.value)
    draft.value = JSON.stringify(obj, null, 2)
    parseError.value = ''
  } catch (e) {
    parseError.value = e instanceof Error ? e.message : 'JSON 格式错误'
  }
}
</script>

<template>
  <div class="panel-content mcp-panel">
    <div class="panel-toolbar mcp-toolbar">
      <div class="filter-wrap">
        <span class="filter-badge">
          服务器 {{ serverCount }} 个 · 启用 {{ enabledCount }} 个
          <template v-if="mcpTools.length"> · MCP 工具 {{ mcpTools.length }} 个</template>
        </span>
        <span v-if="parseError" class="badge red">{{ parseError }}</span>
      </div>
      <button class="tool-button asset-button" title="刷新" @click="ctx.runSafely(() => ctx.loadMcpConfig())">
        <component :is="actionIcons.refresh" class="action-icon" :size="16" />
        <span>刷新</span>
      </button>
    </div>

    <div class="mcp-directory">
      <section class="mcp-directory-section">
        <div class="editor-title">MCP 服务器</div>
        <div class="mcp-server-grid">
          <CapabilityCard
            v-for="item in serverItems"
            :key="item.id"
            :item="item"
          />
          <div v-if="!serverItems.length" class="empty-note">
            尚未配置 MCP 服务器。展开高级配置后添加 servers 并保存。
          </div>
        </div>
      </section>

      <section class="mcp-directory-section">
        <div class="editor-title">已加载的 MCP 工具</div>
        <div class="mcp-tool-list capability-card-grid">
          <div v-if="!mcpTools.length" class="empty-note">
            暂无 MCP 工具。配置并保存 MCP 服务器后即可看到工具列表。
          </div>
          <CapabilityCard
            v-for="item in mcpToolItems"
            :key="item.id"
            :item="item"
          />
        </div>
      </section>
    </div>

    <details class="mcp-advanced-config">
      <summary>
        <span>高级配置</span>
        <em>编辑全局私有 mcp_config.json</em>
      </summary>
      <section class="mcp-editor">
        <div class="editor-title">全局私有数据目录 / mcp_config.json</div>
        <textarea v-model="draft" :class="{ 'has-error': parseError }" spellcheck="false" />
        <div class="mcp-editor-actions">
          <button class="tool-button asset-button" title="格式化" @click="formatJson">
            <span>格式化</span>
          </button>
          <button class="tool-button asset-button primary-action" @click="save">
            <component :is="actionIcons.save" class="action-icon" :size="16" />
            <span>保存配置</span>
          </button>
        </div>
      </section>
    </details>
  </div>
</template>
