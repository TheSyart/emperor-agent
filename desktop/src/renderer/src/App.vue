<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SessionSidebar from './components/layout/SessionSidebar.vue'
import OnboardingWizard from './components/onboarding/OnboardingWizard.vue'
import type { WizardModelSettings } from './components/onboarding/onboardingModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems, parseSkillSlashCommand, parseSlashCommand, slashCommands, type SlashCommand } from './commands'
import { useBootstrap } from './composables/useBootstrap'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useTokens } from './composables/useTokens'
import { provideAppContext } from './composables/useAppContext'
import type { ChatSendPayload, CompactResult, ControlPayload, TokenStatsRow } from './types'
import { core } from './api/http'
import { saveOnboardingModelConfig } from './api/model'
import { formatNumber, usageTypeLabel } from './utils/format'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined
const hideAppSidebar = computed(() => router.currentRoute.value.meta?.hideAppSidebar === true)
const onboardingOpen = ref(false)

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 2600)
}

function openOnboarding() {
  onboardingOpen.value = true
}

function closeOnboarding() {
  onboardingOpen.value = false
}

const bootstrap = useBootstrap(showToast)
const sessionStore = useSession()
const {
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  configContent,
  mcpContent,
  loadBootstrap,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  importSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  saveMcpConfig,
  saveMemory,
  loadEpisode,
  saveEpisode,
  loadMemoryVersion,
  restoreMemoryVersion,
  saveWatchlist,
  checkWatchlist,
  setDesktopPetEnabled,
} = bootstrap

const runtime = useRuntime({
  boot,
  refreshMemory,
  showToast,
  resolveDraftSession: sessionStore.getSession,
  onSessionCreated: sessionStore.applySessionCreatedEvent,
  onSessionTitleUpdated: sessionStore.applySessionTitleUpdatedEvent,
  onSessionControlPendingChanged: sessionStore.applySessionControlPending,
  refreshSessions: sessionStore.load,
})
const {
  messages,
  busy,
  status,
  switchSession,
  pending,
  planProjection,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  connectSocket,
  sendMessage,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  clearChat,
  addLocalCommand,
  restoreFromHistory,
} = runtime

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  if (sessionStore.isDraftSessionId(id)) return
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreFromHistory(boot.value?.unarchivedHistory || [])
}

const tokensClient = useTokens(showToast)
const { data: tokensData, loading: tokensLoading, load: loadTokens } = tokensClient
const slashPaletteItems = computed(() => buildSlashPaletteItems(boot.value?.skills || []))

onMounted(async () => {
  await runInitialStartup({
    sessionStore,
    bootstrap,
    switchSession,
    restoreFromHistory,
    connectSocket,
  })
})

async function refreshAll() {
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    connectSocket()
    showToast('工作台已刷新')
  }
}

async function completeOnboarding(settings: WizardModelSettings) {
  const data = await saveOnboardingModelConfig(settings as unknown as Record<string, unknown>)
  if (boot.value) {
    boot.value.modelConfig = data
    boot.value.model = data.current?.model || boot.value.model
    boot.value.provider = data.current?.provider || boot.value.provider
    boot.value.providerLabel = data.current?.providerLabel || boot.value.providerLabel
  }
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    onboardingOpen.value = false
    connectSocket()
    showToast('模型配置已保存')
  }
}

async function runSafely(task: () => Promise<void>) {
  try {
    await task()
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
}

function submitFromComposer(payload: string | ChatSendPayload) {
  const obj = typeof payload === 'string'
    ? { content: payload, attachments: [] }
    : {
        content: payload.content,
        attachments: payload.attachments || [],
        requestedSkills: payload.requestedSkills || [],
        displayContent: payload.displayContent,
      }
  const parsed = parseSlashCommand(obj.content)
  if (!obj.attachments.length && parsed?.command) {
    void executeSlashCommand(parsed.raw, parsed.name, parsed.command)
    return
  }
  const skillRequest = parseSkillSlashCommand(obj.content, boot.value?.skills || [])
  if (skillRequest) {
    if (!skillRequest.task && !obj.attachments.length) {
      addLocalCommand(
        skillRequest.raw,
        `请在 ${inlineCode(`/${skillRequest.name}`)} 后面补上要办的事，例如：${inlineCode(`/${skillRequest.name} 帮我设计一个设置页`)}`,
      )
      return
    }
    const outgoing: ChatSendPayload = {
      content: skillRequest.task,
      attachments: obj.attachments,
      requestedSkills: [skillRequest.requestedSkill],
      displayContent: skillRequest.raw,
    }
    sendMessage(outgoing)
    return
  }
  if (!obj.attachments.length && parsed) {
    void executeSlashCommand(parsed.raw, parsed.name, parsed.command)
    return
  }
  sendMessage(obj)
}

async function executeSlashCommand(raw: string, name: string, command: SlashCommand | undefined) {
  busy.value = true
  try {
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
    if (command.name === '/memory-log') {
      addLocalCommand(raw, renderMemoryVersions())
      return
    }
    if (command.name === '/memory-restore') {
      await handleMemoryRestoreCommand(raw)
      return
    }
    if (command.name === '/plan') {
      await handlePlanCommand(raw)
      return
    }
    if (command.name === '/mode') {
      await handleModeCommand(raw)
      return
    }
    if (command.name === '/stop') {
      const stopped = await stopActive()
      addLocalCommand(raw, stopped ? '已请求停止当前运行任务。' : '当前没有正在运行的任务。')
      return
    }
    if (command.name === '/compact') {
      pending.label = '正在压缩未归档会话...'
      pending.detail = ''
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
  } finally {
    busy.value = false
    pending.label = ''
    pending.detail = ''
  }
}

function renderCommandHelp() {
  return [
    '## 斜杠命令',
    '',
    ...slashCommands.map((command) => `- ${inlineCode(command.usage)}：${command.description}`),
    '',
    '### Skill 快捷调用',
    '',
    `- ${inlineCode('/<skill-name> 任务')}：强制本轮预加载并使用指定 Skill`,
    `- ${inlineCode('/<skill-name>-skill 任务')}：当名称与系统命令冲突时使用 Skill 别名`,
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
    `- 事件通道：${inlineCode(eventTransportText())}`,
    `- 忙碌状态：${busy.value ? '正在执行' : '空闲'}`,
    `- Provider：${inlineCode(current?.provider || boot.value?.provider || 'unknown')}`,
    `- Main Model：${inlineCode(current?.mainModelId || current?.model || boot.value?.model || 'unknown')}`,
    `- Secondary Model：${current?.secondaryModelId ? inlineCode(current.secondaryModelId) : '未配置'}`,
    `- Token 总量：${Number(totals.total || 0).toLocaleString('zh-CN')}`,
    `- 模型调用：${Number(totals.calls || 0).toLocaleString('zh-CN')} 次`,
    `- Skills：${boot.value?.skills?.length || 0}`,
    `- Tools：${boot.value?.tools?.length || 0}`,
    `- Control：${inlineCode(boot.value?.control?.mode || 'ask_before_edit')}`,
    `- 未归档消息：${unarchived}`,
    `- 当前页：${inlineCode(router.currentRoute.value.name?.toString() || 'chat')}`,
  ].join('\n')
}

async function handlePlanCommand(raw: string) {
  const [, arg = 'status'] = raw.trim().split(/\s+/, 2)
  const normalized = arg.toLowerCase()
  if (normalized === 'on' || normalized === 'plan') {
    const result = await setControlMode('plan')
    addLocalCommand(raw, result.ok ? 'Plan 模式已开启：只读探索、提问、计划预览；批准前不会执行写操作。' : `Plan 模式开启失败：${result.error}`)
    return
  }
  if (normalized === 'off' || normalized === 'normal') {
    const result = await setControlMode('ask_before_edit')
    addLocalCommand(raw, result.ok ? 'Plan 模式已关闭，已回到编辑前询问模式。' : `Plan 模式关闭失败：${result.error}`)
    return
  }
  const pending = boot.value?.control?.pending
  addLocalCommand(raw, [
    '## Plan 模式',
    '',
    `- 当前模式：${inlineCode(boot.value?.control?.mode || 'ask_before_edit')}`,
    `- 进入 Plan 前模式：${boot.value?.control?.previous_mode ? inlineCode(boot.value.control.previous_mode) : '无'}`,
    `- 等待交互：${pending ? inlineCode(`${pending.kind}:${pending.id}`) : '无'}`,
  ].join('\n'))
}

async function handleModeCommand(raw: string) {
  const [, arg = 'status'] = raw.trim().split(/\s+/, 2)
  const normalized = arg.toLowerCase()
  if (['ask', 'ask_before_edit', 'edit_before_ask'].includes(normalized)) {
    const result = await setControlMode('ask_before_edit')
    addLocalCommand(raw, result.ok ? '权限模式已切换为：编辑前询问。' : `权限模式切换失败：${result.error}`)
    return
  }
  if (['accept_edits', 'accept-edits', 'edits'].includes(normalized)) {
    const result = await setControlMode('accept_edits')
    addLocalCommand(raw, result.ok ? '权限模式已切换为：接受编辑。' : `权限模式切换失败：${result.error}`)
    return
  }
  if (normalized === 'auto') {
    const result = await setControlMode('auto')
    addLocalCommand(raw, result.ok ? '权限模式已切换为：自动执行。' : `权限模式切换失败：${result.error}`)
    return
  }
  if (normalized === 'plan') {
    const result = await setControlMode('plan')
    addLocalCommand(raw, result.ok ? '权限模式已切换为：计划模式。' : `权限模式切换失败：${result.error}`)
    return
  }
  addLocalCommand(raw, renderModeStatus())
}

function renderModeStatus() {
  const control = boot.value?.control
  return [
    '## 权限模式',
    '',
    `- 当前模式：${inlineCode(control?.mode || 'ask_before_edit')}`,
    `- 进入 Plan 前模式：${control?.previous_mode ? inlineCode(control.previous_mode) : '无'}`,
    `- 等待交互：${control?.pending ? inlineCode(`${control.pending.kind}:${control.pending.id}`) : '无'}`,
  ].join('\n')
}

async function setControlMode(mode: 'ask_before_edit' | 'accept_edits' | 'auto' | 'plan'): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await core<ControlPayload>('control.setMode', mode)
    if (boot.value) boot.value.control = data
    const label = mode === 'plan' ? '计划模式' : mode === 'auto' ? '自动执行' : mode === 'accept_edits' ? '接受编辑' : '编辑前询问'
    showToast(`已切换为${label}`)
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    showToast(error)
    return { ok: false, error }
  }
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
    `- Main Model：${inlineCode(current?.mainModelId || current?.model || boot.value?.model || 'unknown')}`,
    `- Secondary Model：${current?.secondaryModelId ? inlineCode(current.secondaryModelId) : '未配置'}`,
    `- Secondary Enabled：${payload?.routing?.secondaryEnabled ? 'yes' : 'no'}`,
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
  const content = configContent.value || ''
  const lines = content.split('\n').length
  return [
    '## 配置文件',
    '',
    `- 文件：${inlineCode('templates/USER.local.md')}`,
    `- 行数：${lines}`,
    `- 字符数：${formatNumber(content.length)}`,
    '',
    '可直接在「配置文件」页面查看和编辑。',
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

function renderMemoryVersions() {
  const versions = boot.value?.memory?.versions?.versions || []
  if (!versions.length) {
    return '还没有记忆版本快照。保存长期记忆、情景记忆或压缩记忆后会自动生成。'
  }
  return [
    `## 记忆版本 (${boot.value?.memory?.versions?.count || versions.length})`,
    '',
    ...versions.slice(0, 12).map((version) => [
      `- ${inlineCode(version.id)} · ${version.target} · ${version.relPath}`,
      `  ${new Date(version.createdAt * 1000).toLocaleString('zh-CN', { hour12: false })} · ${version.reason} · ${formatNumber(version.bytes)} bytes`,
    ].join('\n')),
    '',
    `恢复：${inlineCode('/memory-restore <id>')}`,
  ].join('\n')
}

async function handleMemoryRestoreCommand(raw: string) {
  const [, id = ''] = raw.trim().split(/\s+/, 2)
  if (!id) {
    addLocalCommand(raw, `请提供版本 id，例如：${inlineCode('/memory-restore memv_...')}`)
    return
  }
  try {
    const result = await restoreMemoryVersion(id)
    addLocalCommand(raw, `已恢复：${inlineCode(result.restored.path)}`)
  } catch (err) {
    addLocalCommand(raw, `恢复失败：${err instanceof Error ? err.message : String(err)}`)
  }
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
  configContent,
  mcpContent,
  messages,
  busy,
  status,
  pending,
  planProjection,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  commands: slashPaletteItems,
  refreshAll,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  importSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  saveMcpConfig,
  saveMemory,
  loadEpisode,
  saveEpisode,
  loadMemoryVersion,
  restoreMemoryVersion,
  saveWatchlist,
  checkWatchlist,
  setDesktopPetEnabled,
  setControlMode,
  sendMessage,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  clearChat,
  submitFromComposer,
  showToast,
  runSafely,
  openOnboarding,
  tokens: tokensData,
  tokensLoading,
  loadTokens,
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

  <template v-else>
    <div class="app-shell" :class="{ 'settings-app-shell': hideAppSidebar }">
      <SessionSidebar v-if="!hideAppSidebar" @activate="onSessionActivate" />
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>
    <OnboardingWizard :payload="boot" :open="onboardingOpen" :save="completeOnboarding" @close="closeOnboarding" />
  </template>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
