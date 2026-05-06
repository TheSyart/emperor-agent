<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import NavRail from './components/layout/NavRail.vue'
import { parseSlashCommand, slashCommands, type SlashCommand } from './commands'
import { useBootstrap } from './composables/useBootstrap'
import { useRuntime } from './composables/useRuntime'
import { provideAppContext } from './composables/useAppContext'
import type { CompactResult, TokenStatsRow } from './types'
import { brandAssets } from './assets'
import { formatNumber, usageTypeLabel } from './utils/format'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 2600)
}

const bootstrap = useBootstrap(showToast)
const {
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  activeConfig,
  configContent,
  loadBootstrap,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  loadConfig,
  saveConfig,
} = bootstrap

const runtime = useRuntime({ boot, refreshMemory, showToast })
const {
  messages,
  busy,
  status,
  pending,
  runtimeText,
  connectSocket,
  sendMessage,
  clearChat,
  addLocalCommand,
  restoreFromHistory,
} = runtime

onMounted(async () => {
  await loadBootstrap()
  if (!error.value) {
    restoreFromHistory(boot.value?.unarchivedHistory || [])
    connectSocket()
  }
})

async function refreshAll() {
  await loadBootstrap(false)
  if (!error.value) {
    connectSocket()
    showToast('工作台已刷新')
  }
}

async function runSafely(task: () => Promise<void>) {
  try {
    await task()
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
}

function submitFromComposer(content: string) {
  const parsed = parseSlashCommand(content)
  if (!parsed) {
    sendMessage(content)
    return
  }
  void executeSlashCommand(parsed.raw, parsed.name, parsed.command)
}

async function executeSlashCommand(raw: string, name: string, command: SlashCommand | undefined) {
  if (!command) {
    addLocalCommand(raw, `未知命令：${inlineCode(name)}\n\n输入 ${inlineCode('/help')} 查看可用命令。`)
    return
  }

  if (command.name === '/help') {
    addLocalCommand(raw, renderCommandHelp())
    return
  }
  if (command.name === '/status') {
    addLocalCommand(raw, renderStatus())
    return
  }
  if (command.name === '/model') {
    addLocalCommand(raw, renderModelInfo())
    return
  }
  if (command.name === '/tokens') {
    addLocalCommand(raw, renderTokenInfo())
    return
  }
  if (command.name === '/tools') {
    addLocalCommand(raw, renderToolsInfo())
    return
  }
  if (command.name === '/skills') {
    addLocalCommand(raw, renderSkillsInfo())
    return
  }
  if (command.name === '/config') {
    addLocalCommand(raw, renderConfigInfo())
    return
  }
  if (command.name === '/memory') {
    addLocalCommand(raw, renderMemoryInfo())
    return
  }
  if (command.name === '/compact') {
    showToast('/compact 正在压缩未归档会话，会写入 memory/MEMORY.local.md')
    try {
      const result = await compactMemory()
      addLocalCommand(raw, renderCompactResult(result))
    } catch (err) {
      addLocalCommand(raw, `压缩失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  if (command.name === '/clear') {
    clearChat()
    return
  }
  if (command.name === '/reload') {
    await refreshAll()
    addLocalCommand(raw, '工作台状态已刷新。')
    return
  }
}

function renderCommandHelp() {
  return [
    '## 斜杠命令',
    '',
    ...slashCommands.map((command) => `- ${inlineCode(command.usage)}：${command.description}`),
    '',
    '提示：输入 `/` 会显示候选，按 `Tab` 可补全第一项。',
  ].join('\n')
}

function renderStatus() {
  const current = boot.value?.modelConfig?.current
  const totals = boot.value?.memory?.tokenTotals || {}
  const unarchived = boot.value?.unarchivedHistory?.length || 0
  return [
    '## 当前状态',
    '',
    `- 运行时：**${runtimeText()}**`,
    `- WebSocket：${inlineCode(status.value)}`,
    `- 忙碌状态：${busy.value ? '正在执行' : '空闲'}`,
    `- Provider：${inlineCode(current?.provider || boot.value?.provider || 'unknown')}`,
    `- Model：${inlineCode(current?.model || boot.value?.model || 'unknown')}`,
    `- Token 总量：${Number(totals.total || 0).toLocaleString('zh-CN')}`,
    `- 模型调用：${Number(totals.calls || 0).toLocaleString('zh-CN')} 次`,
    `- Skills：${boot.value?.skills?.length || 0}`,
    `- Tools：${boot.value?.tools?.length || 0}`,
    `- 未归档消息：${unarchived}`,
    `- 当前页：${inlineCode(router.currentRoute.value.name?.toString() || 'chat')}`,
  ].join('\n')
}

function renderModelInfo() {
  const payload = boot.value?.modelConfig
  const current = payload?.current
  const provider = current?.provider || boot.value?.provider || 'unknown'
  const rawProvider = payload?.config?.providers?.[provider] || {}
  return [
    '## 模型信息',
    '',
    `- Provider：${inlineCode(provider)}`,
    `- Provider Label：${current?.providerLabel || boot.value?.providerLabel || 'unknown'}`,
    `- Model：${inlineCode(current?.model || boot.value?.model || 'unknown')}`,
    `- API Base：${inlineCode(String(rawProvider.apiBase || current?.apiBase || '未配置'))}`,
    `- Max Tokens：${formatNumber(current?.maxTokens || 0)}`,
    `- Temperature：${current?.temperature ?? '未配置'}`,
    `- Reasoning Effort：${current?.reasoningEffort || 'null'}`,
    `- Context Window：${formatNumber(current?.contextWindowTokens || 0)}`,
    `- 可选 Provider 数：${payload?.providerOptions?.length || 0}`,
    '',
    'API Key 不在命令输出中展示。',
  ].join('\n')
}

function renderTokenInfo() {
  const memory = boot.value?.memory || {}
  const totals = memory.tokenTotals || {}
  return [
    '## Token 消耗',
    '',
    `- 总量：${formatNumber(totals.total || 0)}`,
    `- 调用次数：${formatNumber(totals.calls || 0)}`,
    `- Input：${formatNumber(totals.input || 0)}`,
    `- Output：${formatNumber(totals.output || 0)}`,
    `- Cache Read：${formatNumber(totals.cache_read || 0)}`,
    `- Cache Create：${formatNumber(totals.cache_create || 0)}`,
    '',
    '### 按模型 / 厂家',
    renderStats(memory.tokensByModel, 'model'),
    '',
    '### 按使用种类',
    renderStats(memory.tokensByUsageType, 'usage'),
    '',
    '### 按日期',
    renderStats(memory.tokens, 'date'),
  ].join('\n')
}

function renderToolsInfo() {
  const tools = boot.value?.tools || []
  return [
    `## Tools (${tools.length})`,
    '',
    ...tools.map((tool) => {
      const flags = [
        tool.read_only ? 'read' : 'write',
        tool.concurrency_safe ? 'parallel' : '',
        tool.exclusive ? 'exclusive' : '',
      ].filter(Boolean).join(', ')
      return `- ${inlineCode(tool.name)}：${tool.description || '无描述'} (${flags})`
    }),
  ].join('\n')
}

function renderSkillsInfo() {
  const skills = boot.value?.skills || []
  return [
    `## Skills (${skills.length})`,
    '',
    ...skills.map((skill) => `- ${inlineCode(skill.name)}：${skill.description || skill.path}`),
  ].join('\n')
}

function renderConfigInfo() {
  const configs = boot.value?.configs || []
  return [
    `## 可编辑配置 (${configs.length})`,
    '',
    ...configs.map((config) => `- ${inlineCode(config.path)}：${config.name}`),
    '',
    '当前只允许查看和编辑 `templates/TOOL.md` 与 `templates/USER.md`。',
  ].join('\n')
}

function renderMemoryInfo() {
  const memory = boot.value?.memory || {}
  return [
    '## 记忆状态',
    '',
    `- 长期记忆字符数：${formatNumber((memory.long_term || '').length)}`,
    `- 今日情景记忆字符数：${formatNumber((memory.today_episode || '').length)}`,
    `- 情景记忆文件数：${formatNumber(memory.episodes?.length || 0)}`,
    `- 未归档消息：${formatNumber(boot.value?.unarchivedHistory?.length || 0)}`,
    '',
    '如需立即压缩未归档会话，输入 `/compact`。',
  ].join('\n')
}

function renderCompactResult(result: CompactResult) {
  return [
    '## 会话压缩',
    '',
    `- 状态：${result.status === 'compacted' ? '已压缩' : '跳过'}`,
    `- 处理消息数：${formatNumber(result.count)}`,
    `- 结果：${result.message}`,
    `- 剩余未归档消息：${formatNumber(result.unarchivedHistory.length)}`,
  ].join('\n')
}

function renderStats(stats: Record<string, TokenStatsRow> | undefined, kind: 'model' | 'usage' | 'date') {
  const rows = Object.entries(stats || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0)).slice(0, 8)
  if (!rows.length) return '- 暂无记录'
  return rows
    .map(([key, row]) => `- ${kind === 'usage' ? usageTypeLabel(key) : key}：${formatNumber(row.total || 0)} tokens / ${formatNumber(row.calls || 0)} calls`)
    .join('\n')
}

function inlineCode(value: string) {
  return '`' + value + '`'
}

provideAppContext({
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  activeConfig,
  configContent,
  messages,
  busy,
  status,
  pending,
  runtimeText,
  commands: slashCommands,
  refreshAll,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  loadConfig,
  saveConfig,
  sendMessage,
  clearChat,
  submitFromComposer,
  showToast,
  runSafely,
})
</script>

<template>
  <div v-if="loading" class="loading-shell">
    <div class="seal">令</div>
    <div class="status-pill"><span class="dot busy" />正在连接本地智能体服务</div>
  </div>

  <div v-else-if="error" class="loading-shell">
    <div class="editor error-panel">
      <div class="editor-title">Web UI 启动失败</div>
      <div class="empty-note">{{ error }}</div>
      <button class="tool-button ink mt-4" @click="refreshAll">重新连接</button>
    </div>
  </div>

  <div v-else class="app-shell">
    <img class="app-cover-watermark" :src="brandAssets.ogCover" alt="" aria-hidden="true" />
    <NavRail />
    <router-view v-slot="{ Component }">
      <keep-alive>
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </div>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
