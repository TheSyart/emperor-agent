<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type {
  CommandCompletion,
  CommandDescriptor,
  CommandSurface,
} from '@emperor/core'
import SessionSidebar from './components/layout/SessionSidebar.vue'
import CommandCenterDialog, {
  type CommandCenterItem,
} from './components/commands/CommandCenterDialog.vue'
import ModelSetupRequiredDialog from './components/onboarding/ModelSetupRequiredDialog.vue'
import { shouldShowModelSetupPrompt } from './components/onboarding/modelSetupDialogModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import { core } from './api/http'
import { useBootstrap } from './composables/useBootstrap'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useTokens } from './composables/useTokens'
import { useSlashCommands } from './composables/useSlashCommands'
import { createGoalCaptureController } from './composables/goalCapture'
import { provideAppContext } from './composables/useAppContext'
import { activeGoalForSession } from './runtime/selectors'
import { isTerminalGoal, type GoalCardAction } from './runtime/goalRender'
import { applyTheme } from './theme/tokens'
import type {
  GoalOperationResult,
  RuntimeGoalSummary,
  SessionInfo,
} from './types'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined
const hideAppSidebar = computed(
  () => router.currentRoute.value.meta?.hideAppSidebar === true,
)
const modelSetupPromptOpen = ref(false)
const modelSetupDismissed = ref(false)
const commandDescriptors = ref<CommandDescriptor[]>([])
const commandDialog = reactive<{
  open: boolean
  title: string
  description: string
  items: CommandCenterItem[]
  mode: 'commands' | 'sessions' | 'info'
}>({
  open: false,
  title: '',
  description: '',
  items: [],
  mode: 'info',
})

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 2600)
}

function closeModelSetupPrompt() {
  modelSetupDismissed.value = true
  modelSetupPromptOpen.value = false
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
  startProfileInterview: startProfileInterviewBase,
  skipProfileInterview: skipProfileInterviewBase,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  loadMcpStatus,
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
  queuedPrompts,
  queueDraftRecovery,
  clearQueueDraftRecovery,
  pendingInteractionsBySession,
  busy,
  status,
  switchSession,
  pending,
  planProjection,
  goalProjection,
  turnChangeProjection,
  activeTurnChange,
  sessionId,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  dispose: disposeRuntime,
  connectSocket,
  sendMessage,
  manageQueuedPrompt,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  restoreFromHistory,
} = runtime

const currentGoal = computed(() => {
  const projected = activeGoalForSession(goalProjection, sessionId.value)
  if (projected) return projected
  const bootstrapActive = boot.value?.goals?.active
  return bootstrapActive?.sessionId === sessionId.value &&
    !goalProjection.byId[bootstrapActive.id]
    ? bootstrapActive
    : null
})

function applyGoalSummary(goal: RuntimeGoalSummary) {
  goalProjection.byId[goal.id] = goal
  if (isTerminalGoal(goal)) {
    if (goalProjection.activeBySession[goal.sessionId] === goal.id)
      delete goalProjection.activeBySession[goal.sessionId]
  } else {
    goalProjection.activeBySession[goal.sessionId] = goal.id
  }
  if (boot.value) {
    const recent = [
      goal,
      ...(boot.value.goals?.recent || []).filter((item) => item.id !== goal.id),
    ].slice(0, 50)
    boot.value.goals = {
      active: isTerminalGoal(goal)
        ? boot.value.goals?.active?.id === goal.id
          ? null
          : boot.value.goals?.active || null
        : goal,
      recent,
    }
  }
}

async function startGoal(outcome: string): Promise<GoalOperationResult> {
  const owner = sessionId.value
  const draft = sessionStore.isDraftSessionId(owner)
    ? sessionStore.getSession(owner)
    : null
  const result = await core('goals.start', {
    outcome,
    sessionId: owner,
    ...(draft
      ? {
          clientDraftId: owner,
          draftSession: {
            mode:
              draft.mode === 'build' ? ('build' as const) : ('chat' as const),
            project: {
              project_id: draft.project_id ?? null,
              project_path: draft.project_path ?? null,
              project_name: draft.project_name ?? null,
            },
          },
        }
      : {}),
  })
  applyGoalSummary(result.goal)
  return result
}

const goalCapture = createGoalCaptureController({
  currentSessionId: () => sessionId.value,
  hasActiveGoal: () => Boolean(currentGoal.value),
  startGoal,
})

watch(sessionId, () => {
  goalCapture.reset()
})

async function runGoalAction(
  goalId: string,
  action: GoalCardAction,
  reason = 'user_confirmed_cancel',
): Promise<GoalOperationResult> {
  const result =
    action === 'pause'
      ? await core('goals.pause', goalId)
      : action === 'resume'
        ? await core('goals.resume', goalId)
        : await core('goals.cancel', goalId, reason)
  applyGoalSummary(result.goal)
  showToast(
    action === 'pause'
      ? 'Goal 已暂停'
      : action === 'resume'
        ? 'Goal 已恢复'
        : 'Goal 已取消',
  )
  return result
}

async function replaceGoal(
  goalId: string,
  outcome: string,
): Promise<GoalOperationResult> {
  const result = await core('goals.replace', {
    goalId,
    outcome,
    sessionId: sessionId.value,
  })
  applyGoalSummary(result.goal)
  showToast('已创建替代 Goal')
  return result
}

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  if (sessionStore.isDraftSessionId(id)) return
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreFromHistory(boot.value?.unarchivedHistory || [])
}

async function openProfileInterviewSession(sessionId: string | null) {
  if (!sessionId) return
  await sessionStore.load()
  await onSessionActivate(sessionId)
  await router.push('/').catch(() => undefined)
}

async function startProfileInterview() {
  const result = await startProfileInterviewBase()
  if (result.started) {
    await openProfileInterviewSession(result.state.sessionId)
    return
  }
  if (result.state.status === 'completed') showToast('个人档案已完成')
  else if (result.state.lastError) showToast(result.state.lastError)
}

async function skipProfileInterview() {
  await skipProfileInterviewBase()
}

const tokensClient = useTokens(showToast)
const {
  data: tokensData,
  loading: tokensLoading,
  load: loadTokens,
} = tokensClient
const slashPaletteItems = computed(() =>
  buildSlashPaletteItems(commandDescriptors.value, recentCommandIds()),
)
const modelSetupMessage = computed(
  () =>
    boot.value?.modelConfig?.availability?.message ||
    '还没有可用模型，请先配置模型。',
)

onMounted(async () => {
  await runInitialStartup({
    sessionStore,
    bootstrap,
    switchSession,
    restoreFromHistory,
    connectSocket,
  })
  await loadCommands()
})

onBeforeUnmount(() => disposeRuntime())

async function refreshAll() {
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    connectSocket()
    await loadCommands()
    showToast('工作台已刷新')
  }
}

watch(sessionId, () => void loadCommands())

async function loadCommands(includeUnavailable = false): Promise<void> {
  const owner = commandCatalogSessionId()
  if (!owner) {
    commandDescriptors.value = []
    return
  }
  try {
    commandDescriptors.value = await core('commands.list', {
      sessionId: owner,
      includeUnavailable,
      invocationSource: 'desktop',
    })
  } catch (cause) {
    commandDescriptors.value = []
    if (includeUnavailable)
      showToast(cause instanceof Error ? cause.message : String(cause))
  }
}

function commandCatalogSessionId(): string {
  return (
    sessionStore.backendSessionId() ||
    sessionStore.sessions.value.find((item) => !item.draft)?.id ||
    ''
  )
}

async function resolveCommandSessionId(): Promise<string> {
  const current = sessionStore.backendSessionId()
  if (current) return current
  const draft = sessionStore.getSession(sessionId.value)
  const created = await core('sessions.create', {
    title: draft?.title || '新会话',
    mode: draft?.mode || 'chat',
    project:
      draft?.mode === 'build'
        ? {
            project_id: draft.project_id ?? null,
            project_path: draft.project_path ?? null,
            project_name: draft.project_name ?? null,
          }
        : null,
  })
  await sessionStore.load()
  await onSessionActivate(created.id)
  await loadCommands()
  return created.id
}

async function completeSlashCommand(
  commandId: string,
  rawArgs: string,
  cursor: number,
): Promise<CommandCompletion[]> {
  const owner = commandCatalogSessionId()
  if (!owner) return []
  return await core('commands.complete', {
    sessionId: owner,
    commandId,
    rawArgs,
    cursor,
    invocationSource: 'desktop',
  })
}

async function activateTransitionedSession(
  session: SessionInfo,
): Promise<void> {
  await sessionStore.load()
  await onSessionActivate(session.id)
  await router.push('/chat').catch(() => undefined)
  await loadCommands()
}

async function copyLastAssistant(): Promise<boolean> {
  const last = [...messages.value]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())
  if (!last) return false
  await navigator.clipboard.writeText(last.content)
  return true
}

async function openCommandSurface(
  surface: CommandSurface,
  params: Record<string, unknown> = {},
): Promise<void> {
  const rawArgs = String(params.rawArgs ?? '').trim()
  if (surface === 'command_center') {
    const options = (params.options ?? {}) as Record<string, unknown>
    const catalog =
      options.all === true
        ? await core('commands.list', {
            sessionId: commandCatalogSessionId(),
            includeUnavailable: true,
            invocationSource: 'desktop',
          })
        : commandDescriptors.value
    commandDialog.open = true
    commandDialog.mode = 'commands'
    commandDialog.title = '命令中心'
    commandDialog.description =
      '命令由 Core 校验并执行；不可用项不会绕过安全边界。'
    commandDialog.items = catalog.map((command) => ({
      id: command.id,
      label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
      description: command.description,
      meta: `${command.dangerous ? '需确认 · ' : ''}${command.source === 'builtin' ? command.category : command.source}`,
      disabled: !command.available,
      disabledReason: command.unavailableReason,
    }))
    return
  }
  if (surface === 'session_search') {
    const sessions = await sessionStore.loadArchived()
    const needle = rawArgs.toLowerCase()
    const matches = sessions.filter((item) =>
      !needle
        ? true
        : `${item.id} ${item.title} ${item.preview}`
            .toLowerCase()
            .includes(needle),
    )
    if (needle && matches.length === 1) {
      await onSessionActivate(matches[0]!.id)
      await router.push('/chat').catch(() => undefined)
      return
    }
    commandDialog.open = true
    commandDialog.mode = 'sessions'
    commandDialog.title = '恢复历史会话'
    commandDialog.description = needle
      ? `找到 ${matches.length} 个匹配会话`
      : '选择要恢复的会话；当前会话不会被删除。'
    commandDialog.items = matches.map((item) => ({
      id: `session:${item.id}`,
      label: item.title,
      description: item.preview || '暂无摘要',
      meta: item.archived_at ? '已归档' : item.mode || 'chat',
    }))
    return
  }
  if (surface === 'rename_session') {
    const title = window.prompt('输入新的会话标题')?.trim()
    if (title) {
      const renamed = await sessionStore.rename(sessionId.value, title)
      showToast(renamed ? '会话已重命名。' : '会话重命名失败。')
    }
    return
  }
  if (surface === 'export_session') {
    exportCurrentConversation(rawArgs)
    return
  }
  if (surface === 'theme') {
    if (rawArgs === 'dark' || rawArgs === 'light') {
      applyTheme(document, rawArgs)
      localStorage.setItem('emperor.theme', rawArgs)
    } else await router.push('/settings/appearance').catch(() => undefined)
    return
  }
  const route = routeForCommandSurface(surface, rawArgs)
  if (route) {
    await router.push(route).catch(() => undefined)
    return
  }
  if (surface === 'review' || surface === 'files' || surface === 'terminal') {
    await router.push('/chat').catch(() => undefined)
    window.dispatchEvent(
      new CustomEvent('emperor:open-workspace', {
        detail: {
          pane: surface,
          paths: surface === 'review' && rawArgs ? [rawArgs] : [],
          query: surface === 'files' ? rawArgs : '',
        },
      }),
    )
    return
  }
  showInfoSurface(surface)
}

function routeForCommandSurface(
  surface: CommandSurface,
  rawArgs: string,
): string {
  if (surface === 'cost') return '/tokens'
  if (surface === 'config') return '/configs'
  if (surface === 'diagnostics') return '/settings/diagnostics'
  if (surface === 'model' || surface === 'effort') return '/settings/model'
  if (surface === 'permissions') return '/settings/general'
  if (surface === 'memory') return '/memory'
  if (surface === 'skills') return `/skills/${encodeURIComponent(rawArgs)}`
  if (surface === 'tools') return '/tools'
  if (surface === 'mcp') return '/plugins/mcp'
  if (surface === 'hooks') return '/plugins/hooks'
  if (surface === 'scheduler') return '/scheduler'
  if (surface === 'plugins') return '/plugins/skills'
  return ''
}

function showInfoSurface(surface: CommandSurface): void {
  const activeTasks = boot.value?.runtime?.active_tasks ?? []
  const descriptions: Partial<Record<CommandSurface, string>> = {
    status: `会话：${sessionId.value}\n模型：${boot.value?.modelConfig?.current?.effectiveDisplayName || '未配置'}\n状态：${status.value}`,
    context: `已用上下文：${boot.value?.context_used ?? 0} tokens\n运行事件：${boot.value?.runtime?.events?.length ?? 0}`,
    plan: (() => {
      const active = [...planProjection.plans]
        .reverse()
        .find((plan) =>
          ['draft', 'waiting', 'approved', 'executing'].includes(plan.status),
        )
      return active ? `当前计划：${active.title}` : '当前没有活动 Plan。'
    })(),
    goal: currentGoal.value
      ? `当前 Goal：${currentGoal.value.outcome}`
      : '当前没有活动 Goal。',
    agents: `当前活动任务：${activeTasks.length}`,
    tasks: activeTasks.length
      ? `${activeTasks.length} 个后台或前台任务`
      : '当前没有后台任务。',
  }
  commandDialog.open = true
  commandDialog.mode = 'info'
  commandDialog.title = surfaceLabel(surface)
  commandDialog.description = descriptions[surface] || '该面板已打开。'
  commandDialog.items = []
}

async function selectCommandCenterItem(item: CommandCenterItem): Promise<void> {
  if (item.disabled) return
  if (item.id.startsWith('session:')) {
    commandDialog.open = false
    await onSessionActivate(item.id.slice('session:'.length))
    await router.push('/chat').catch(() => undefined)
    return
  }
  const command = commandDescriptors.value.find(
    (candidate) => candidate.id === item.id,
  )
  if (!command) return
  commandDialog.open = false
  await router.push('/chat').catch(() => undefined)
  window.dispatchEvent(
    new CustomEvent('emperor:set-composer-draft', {
      detail: {
        text: `/${command.name}${command.argumentSchema.some((arg) => arg.required) ? ' ' : ''}`,
      },
    }),
  )
}

function exportCurrentConversation(filename: string): void {
  const body = messages.value
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}\n${message.content}`,
    )
    .join('\n\n---\n\n')
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download =
    filename ||
    `${sessionStore.getSession(sessionId.value)?.title || 'conversation'}.md`
  link.click()
  URL.revokeObjectURL(href)
}

function surfaceLabel(surface: CommandSurface): string {
  const labels: Partial<Record<CommandSurface, string>> = {
    status: '当前状态',
    context: '上下文',
    plan: 'Plan',
    goal: 'Goal',
    agents: 'Agents',
    tasks: '任务',
  }
  return labels[surface] || surface
}

function recentCommandIds(): string[] {
  try {
    const value = JSON.parse(
      localStorage.getItem('emperor.recent_commands.v1') || '[]',
    )
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

async function configureModelFromPrompt() {
  modelSetupDismissed.value = true
  modelSetupPromptOpen.value = false
  await router.push('/settings/model').catch(() => undefined)
}

watch(
  () => boot.value?.modelConfig?.availability?.usable,
  () => {
    if (!boot.value) return
    const shouldPrompt = shouldShowModelSetupPrompt(boot.value)
    if (!shouldPrompt) {
      modelSetupPromptOpen.value = false
      modelSetupDismissed.value = false
      return
    }
    if (!modelSetupDismissed.value) modelSetupPromptOpen.value = true
  },
  { immediate: true },
)

async function runSafely(task: () => Promise<void>) {
  try {
    await task()
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
}

const {
  submitFromComposer,
  setPermissionMode,
  activatePlan,
  activateGoalCapture,
  startGoalWithLifecycle,
  dismissLifecycle,
  reconcileTerminalGoal,
} = useSlashCommands({
  boot,
  busy,
  commandDescriptors,
  resolveSessionId: resolveCommandSessionId,
  sendMessage,
  reloadCommands: loadCommands,
  refreshAll,
  openCommandSurface,
  activateTransitionedSession,
  copyLastAssistant,
  showToast,
  currentGoal: () => currentGoal.value,
  startGoal,
  runGoalAction,
  currentGoalCaptureStatus: () => goalCapture.state.value.status,
  armGoalCapture: goalCapture.arm,
  clearGoalCapture: goalCapture.reset,
  startCapturedGoal: goalCapture.start,
})

watch(
  () => ({ sessionId: sessionId.value, goalId: currentGoal.value?.id || null }),
  (current, previous) => {
    if (!previous || current.sessionId !== previous.sessionId) return
    if (!previous.goalId || current.goalId) return
    const goal = goalProjection.byId[previous.goalId]
    if (!goal || !isTerminalGoal(goal)) return
    void reconcileTerminalGoal(previous.goalId).then((result) => {
      if (!result.ok && result.error) showToast(result.error)
    })
  },
)

provideAppContext({
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  configContent,
  mcpContent,
  messages,
  queuedPrompts,
  queueDraftRecovery,
  clearQueueDraftRecovery,
  pendingInteractionsBySession,
  busy,
  status,
  pending,
  planProjection,
  goalProjection,
  turnChangeProjection,
  activeTurnChange,
  goalCaptureState: goalCapture.state,
  sessionId,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  commands: slashPaletteItems,
  completeSlashCommand,
  refreshAll,
  refreshMemory,
  openProfileInterviewSession,
  startProfileInterview,
  skipProfileInterview,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  loadMcpStatus,
  saveMcpConfig,
  saveMemory,
  loadEpisode,
  saveEpisode,
  loadMemoryVersion,
  restoreMemoryVersion,
  saveWatchlist,
  checkWatchlist,
  setDesktopPetEnabled,
  setPermissionMode,
  activatePlan,
  activateGoalCapture,
  startGoalWithLifecycle,
  dismissLifecycle,
  sendMessage,
  manageQueuedPrompt,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  runGoalAction,
  replaceGoal,
  startGoal,
  submitFromComposer,
  showToast,
  runSafely,
  tokens: tokensData,
  tokensLoading,
  loadTokens,
})
</script>

<template>
  <div v-if="loading" class="loading-shell">
    <div class="seal">令</div>
    <div class="status-pill">
      <span class="dot busy" />正在连接本地智能体服务
    </div>
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
    <ModelSetupRequiredDialog
      :open="modelSetupPromptOpen"
      :message="modelSetupMessage"
      @close="closeModelSetupPrompt"
      @configure="configureModelFromPrompt"
    />
    <CommandCenterDialog
      :open="commandDialog.open"
      :title="commandDialog.title"
      :description="commandDialog.description"
      :items="commandDialog.items"
      @close="commandDialog.open = false"
      @select="selectCommandCenterItem"
    />
  </template>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
