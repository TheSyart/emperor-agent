<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAppContext } from '../composables/useAppContext'
import { actionIcons } from '../icons'

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

const mcpTools = computed(() => {
  return ctx.boot.value?.tools?.filter((t) => t.source === 'mcp') || []
})

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
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>MCP 配置</h1>
        <p>mcp_config.json — 外部 MCP 服务器连接配置</p>
      </div>
      <div class="flex gap-2">
        <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.runSafely(() => ctx.loadMcpConfig())">
          <component :is="actionIcons.refresh" class="action-icon" :size="16" />
          <span>刷新</span>
        </button>
        <button class="tool-button asset-button" title="格式化" @click="formatJson">
          <span>格式化</span>
        </button>
      </div>
    </header>

    <div class="view-body view-body-fill">
      <div class="panel-content split-panel compact-split">
        <!-- 编辑器 -->
        <div class="editor flex-1">
          <div class="editor-title">
            mcp_config.json
            <span v-if="parseError" class="badge red ml-2">{{ parseError }}</span>
          </div>
          <textarea v-model="draft" :class="{ 'has-error': parseError }" />
          <div class="editor-actions">
            <span class="status-pill">
              服务器: {{ serverCount }} 个（启用 {{ enabledCount }} 个）
              <template v-if="mcpTools.length">· MCP 工具: {{ mcpTools.length }} 个</template>
            </span>
            <button class="tool-button ink asset-button primary-action" @click="save">
              <component :is="actionIcons.save" class="action-icon" :size="16" />
              <span>保存配置</span>
            </button>
          </div>
        </div>

        <!-- 工具列表 -->
        <div class="editor flex-1" style="max-width: 420px;">
          <div class="editor-title">已加载的 MCP 工具</div>
          <div class="tool-list">
            <div v-if="!mcpTools.length" class="empty-note">
              暂无 MCP 工具。配置并保存 MCP 服务器后即可看到工具列表。
            </div>
            <div
              v-for="tool in mcpTools"
              :key="tool.name"
              class="tool-card"
            >
              <div class="tool-name-row">
                <code class="tool-name">{{ tool.name }}</code>
                <span class="badge blue">{{ tool.server }}</span>
              </div>
              <p class="tool-desc">{{ tool.description }}</p>
              <div class="tool-badges">
                <span class="badge" :class="tool.read_only ? 'green' : 'red'">{{ tool.read_only ? '只读' : '可写' }}</span>
                <span v-if="tool.concurrency_safe" class="badge green">并发安全</span>
                <span v-if="tool.exclusive" class="badge gold">独占</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tool-list {
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
}
.tool-card {
  border: 1px solid rgba(151, 44, 31, 0.15);
  border-radius: 12px;
  padding: 12px;
  background: rgba(247, 239, 222, 0.6);
}
.tool-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.tool-name {
  font-size: 13px;
  font-weight: 600;
  color: #972c1f;
}
.tool-desc {
  font-size: 12px;
  color: #5a4638;
  line-height: 1.5;
  margin: 0 0 8px;
}
.tool-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
textarea.has-error {
  border-color: #dc2626;
  background: rgba(220, 38, 38, 0.04);
}
.ml-2 {
  margin-left: 8px;
}
</style>
