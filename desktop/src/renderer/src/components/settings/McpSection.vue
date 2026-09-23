<script setup lang="ts">
/**
 * McpSection — the MCP tab of the /capabilities page (能力 › MCP), on
 * components/settings/ui (dsh
 * McpSettingsTab): one expandable McpServerCard per server of Emperor's own
 * `mcp_config.json` (status dot, transport, tool count, enable Switch,
 * facts + tools + 删除), the header 「添加」 dialog (paste JSON / form with a
 * live dry-run preview) and the raw `mcp_config.json` editor folded under
 * 「高级」.
 *
 * Data: the masked config view (`mcp.getConfig`, source of the list), the
 * `mcp.status` snapshot (mirrored into boot.mcp) and boot.tools for tool
 * descriptions — refreshed after every change so the rest of the app (Tools
 * section, composer) sees the new MCP tools. While a server is still
 * connecting the status is polled briefly. Showing the kept-alive page
 * again re-reads the config and the status.
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue'
import Button from '../ui/Button.vue'
import Modal from '../ui/Modal.vue'
import { DsApi, DsPlus } from '../icons/ds'
import {
  CodeEditor,
  EmptyState,
  Field,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
  StatusBadge,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { onPageReactivated } from '../pages/pageLifecycle'
import { useAppContext } from '../../composables/useAppContext'
import { core } from '../../api/http'
import {
  getMcpConfig,
  getMcpStatus,
  removeMcpServer,
  setMcpServerEnabled,
  type McpConfigView,
  type McpImportResult,
  type McpStatusView,
} from '../../api/mcp'
import type { BootstrapPayload } from '../../types'
import McpAddDialog from './mcp/McpAddDialog.vue'
import McpServerCard from './mcp/McpServerCard.vue'
import {
  buildMcpServerViews,
  mcpImportSummary,
  type McpStatusLike,
} from './mcp/mcpModel'

/** Poll mcp.status while a server is connecting: every 2s, at most 10 times. */
const POLL_INTERVAL_MS = 2000
const POLL_LIMIT = 10
const EXAMPLE_SNIPPET = '{ "mcpServers": { "名称": { "url": "https://…" } } }'
const EMPTY_DESCRIPTION =
  '点击右上角「添加」，粘贴 Claude、Cursor、VS Code 等客户端的 MCP 配置即可导入；也可以用表单填写服务地址或启动命令。'

const ctx = useAppContext()

const config = shallowRef<McpConfigView | null>(null)
const statusOverride = shallowRef<McpStatusLike | null>(null)
const loadError = ref('')
const addOpen = ref(false)
const expanded = reactive<Record<string, boolean>>({})
const busy = reactive<Record<string, boolean>>({})
const enabledOverride = reactive<Record<string, boolean>>({})
const removing = ref<string | null>(null)
const removeError = ref('')

const status = computed<McpStatusLike | null>(
  () => statusOverride.value ?? ctx.boot.value?.mcp ?? null,
)

const servers = computed(() =>
  buildMcpServerViews(config.value, status.value, ctx.boot.value?.tools).map(
    (view) =>
      view.name in enabledOverride
        ? { ...view, enabled: enabledOverride[view.name]! }
        : view,
  ),
)

const summary = computed(() => {
  const list = servers.value
  if (!list.length) return ''
  const enabled = list.filter((server) => server.enabled).length
  const connected = list.filter((server) => server.state === 'connected').length
  const tools = list.reduce((total, server) => total + server.toolCount, 0)
  return `${list.length} 个服务器 · 已连接 ${connected}/${enabled} · ${tools} 个工具`
})

const removeOpen = computed({
  get: () => removing.value !== null,
  set: (value: boolean) => {
    if (!value) removing.value = null
  },
})

useSettingsHeader({
  actions: () => [
    refreshAction(() => refresh(true), { title: '刷新 MCP 状态' }),
    {
      id: 'add',
      label: '添加',
      kind: 'primary',
      icon: DsPlus,
      onClick: () => {
        addOpen.value = true
      },
    },
  ],
})

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function applyStatus(next: McpStatusView | null | undefined) {
  if (!next) return
  statusOverride.value = next
  if (ctx.boot.value) ctx.boot.value.mcp = next as BootstrapPayload['mcp']
}

async function loadConfig() {
  config.value = await getMcpConfig()
}

async function loadStatus() {
  applyStatus(await getMcpStatus())
}

/** Re-read boot.tools (MCP tool descriptions) and the status after a change. */
async function refreshTools() {
  try {
    const payload = await core('bootstrap', { sessionId: null })
    if (ctx.boot.value) ctx.boot.value.tools = payload.tools
    applyStatus(payload.mcp)
  } catch {
    // Cards still list tool names from mcp.status.
  }
}

async function refresh(withTools = false) {
  try {
    await Promise.all([loadConfig(), loadStatus()])
    loadError.value = ''
    if (withTools) await refreshTools()
  } catch (error) {
    loadError.value = messageOf(error)
  }
  schedulePoll()
}

let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollCount = 0

function connectedKey() {
  return servers.value
    .filter((server) => server.state === 'connected')
    .map((server) => `${server.name}:${server.toolCount}`)
    .join(',')
}

function schedulePoll(restart = true) {
  if (restart) pollCount = 0
  clearTimeout(pollTimer)
  pollTimer = undefined
  const settling = servers.value.some((server) => server.state === 'connecting')
  if (!settling || pollCount >= POLL_LIMIT) return
  pollTimer = setTimeout(async () => {
    pollCount += 1
    const before = connectedKey()
    try {
      await loadStatus()
    } catch {
      // Keep the last snapshot; the next tick or a manual refresh retries.
    }
    if (connectedKey() !== before) await refreshTools()
    schedulePoll(false)
  }, POLL_INTERVAL_MS)
}

onMounted(() => void refresh())
onPageReactivated(() => refresh())
onBeforeUnmount(() => clearTimeout(pollTimer))

async function toggle(name: string, enabled: boolean) {
  busy[name] = true
  enabledOverride[name] = enabled
  try {
    const result = await setMcpServerEnabled(name, enabled)
    config.value = result.config
    applyStatus(result.status)
    ctx.showToast(enabled ? `已启用 ${name}` : `已停用 ${name}`)
    await refreshTools()
  } catch (error) {
    ctx.showToast(messageOf(error))
  } finally {
    delete busy[name]
    delete enabledOverride[name]
  }
  schedulePoll()
}

function askRemove(name: string) {
  removeError.value = ''
  removing.value = name
}

async function confirmRemove() {
  const name = removing.value
  if (!name) return
  busy[name] = true
  removeError.value = ''
  try {
    const result = await removeMcpServer(name)
    config.value = result.config
    applyStatus(result.status)
    removing.value = null
    delete expanded[name]
    ctx.showToast(`已删除 MCP 服务器「${name}」`)
    await refreshTools()
  } catch (error) {
    removeError.value = messageOf(error)
  } finally {
    delete busy[name]
  }
}

async function onImported(result: McpImportResult) {
  config.value = result.config
  applyStatus(result.status)
  ctx.showToast(mcpImportSummary(result))
  await refreshTools()
  schedulePoll()
}

// ── 高级：原始 mcp_config.json ───────────────────────────────────────

const advancedOpen = ref(false)
const draft = ref('')
const draftBase = ref('')
const draftError = ref('')
const saving = ref(false)
const dirty = computed(() => draft.value !== draftBase.value)

watch(
  config,
  (value) => {
    const text = value ? `${JSON.stringify(value, null, 2)}\n` : ''
    if (!dirty.value) draft.value = text
    draftBase.value = text
  },
  { immediate: true },
)

watch(draft, () => {
  draftError.value = ''
})

function parseDraft(): unknown {
  try {
    return JSON.parse(draft.value)
  } catch (error) {
    draftError.value = `JSON 格式错误：${messageOf(error)}`
    return undefined
  }
}

function formatDraft() {
  const parsed = parseDraft()
  if (parsed !== undefined) draft.value = `${JSON.stringify(parsed, null, 2)}\n`
}

function revertDraft() {
  draft.value = draftBase.value
}

async function saveDraft() {
  if (!dirty.value || saving.value || parseDraft() === undefined) return
  saving.value = true
  try {
    await ctx.saveMcpConfig(draft.value)
    await Promise.all([loadConfig(), loadStatus()])
    draft.value = draftBase.value
    schedulePoll()
  } catch (error) {
    draftError.value = messageOf(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection
    intro="连接外部 MCP 服务器，为 Agent 增加工具。配置写入 Emperor 自己的 mcp_config.json，不会改动其他客户端。"
  >
    <SettingsGroup title="服务器" :description="summary" variant="stack">
      <EmptyState
        v-if="loadError && !config"
        compact
        title="无法读取 MCP 配置"
        :description="loadError"
      >
        <Button size="sm" variant="outline" @click="refresh(true)">重试</Button>
      </EmptyState>
      <p v-else-if="!config" class="loading">正在读取 MCP 配置…</p>
      <EmptyState
        v-else-if="!servers.length"
        :icon="DsApi"
        title="还没有 MCP 服务器"
        data-testid="mcp-empty"
      >
        <template #description>
          <span class="empty-text">{{ EMPTY_DESCRIPTION }}</span>
          <code class="empty-example">{{ EXAMPLE_SNIPPET }}</code>
        </template>
        <Button size="sm" variant="outline" @click="addOpen = true">
          <template #icon><DsPlus :size="14" /></template>
          添加服务器
        </Button>
      </EmptyState>
      <template v-else>
        <McpServerCard
          v-for="server in servers"
          :key="server.name"
          v-model:open="expanded[server.name]"
          :server="server"
          :busy="Boolean(busy[server.name])"
          @toggle="(enabled) => toggle(server.name, enabled)"
          @remove="askRemove(server.name)"
        />
      </template>
    </SettingsGroup>

    <SettingsGroup
      v-if="config"
      title="高级"
      description="直接编辑 mcp_config.json；适合批量调整或设置 tool_overrides。"
      variant="stack"
    >
      <SettingsCard
        v-model:open="advancedOpen"
        expandable
        variant="outline"
        title="原始配置"
        description="密钥显示为 [REDACTED]，保存时会保留原值。"
      >
        <template #meta>
          <StatusBadge v-if="dirty" tone="warn">未保存</StatusBadge>
        </template>
        <Field :error="draftError">
          <CodeEditor
            v-model="draft"
            language="json"
            :min-lines="10"
            :max-lines="22"
            aria-label="mcp_config.json"
            @save="saveDraft"
          />
        </Field>
        <template #footer>
          <Button
            size="sm"
            variant="ghost"
            :disabled="!dirty"
            @click="revertDraft"
          >
            还原
          </Button>
          <Button size="sm" variant="outline" @click="formatDraft">
            格式化
          </Button>
          <Button
            size="sm"
            variant="primary"
            :disabled="!dirty || saving"
            @click="saveDraft"
          >
            {{ saving ? '正在保存…' : '保存' }}
          </Button>
        </template>
      </SettingsCard>
    </SettingsGroup>

    <McpAddDialog v-model:open="addOpen" @imported="onImported" />

    <Modal
      v-model:open="removeOpen"
      :title="`删除 ${removing ?? ''}？`"
      description="将从 mcp_config.json 移除该服务器并断开连接，它提供的工具也会从 Agent 中移除。"
    >
      <p v-if="removeError" class="remove-error" role="alert">
        {{ removeError }}
      </p>
      <template #footer>
        <Button variant="outline" @click="removing = null">取消</Button>
        <Button
          variant="danger"
          data-testid="mcp-remove-confirm"
          :disabled="Boolean(removing && busy[removing])"
          @click="confirmRemove"
        >
          删除
        </Button>
      </template>
    </Modal>
  </SettingsSection>
</template>

<style scoped>
.loading {
  margin: 0;
  padding: var(--space-3) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.empty-text {
  display: block;
}

.empty-example {
  display: inline-block;
  max-width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--interactive-bg-hover);
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.remove-error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
