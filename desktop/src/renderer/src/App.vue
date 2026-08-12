<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type {
  CommandCompletion,
  CommandDescriptor,
  CommandSurface,
} from '@emperor/core/api'
import SessionSidebar from './components/layout/SessionSidebar.vue'
import ModelSetupRequiredDialog from './components/onboarding/ModelSetupRequiredDialog.vue'
import { shouldShowModelSetupPrompt } from './components/onboarding/modelSetupDialogModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import { createCommandCatalogLoader } from './commandCatalog'
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
  refreshCommands: () => loadCommands(),
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
  buildSlashPaletteItems(commandDescriptors.value),
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

function commandCatalogSessionId(): string {
  return (
    sessionStore.backendSessionId() ||
    sessionStore.sessions.value.find((item) => !item.draft)?.id ||
    ''
  )
}

const commandCatalog = createCommandCatalogLoader({
  currentSessionId: commandCatalogSessionId,
  list: (owner) =>
    core('commands.list', {
      sessionId: owner,
      includeUnavailable: false,
      invocationSource: 'desktop',
    }),
  apply: (commands) => {
    commandDescriptors.value = commands
  },
  onError: (cause) => console.warn('Unable to refresh slash commands', cause),
})

async function loadCommands(): Promise<void> {
  await commandCatalog.refresh()
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

async function openCommandSurface(
  surface: CommandSurface,
  _params: Record<string, unknown> = {},
): Promise<void> {
  if (surface === 'model' || surface === 'reasoning') {
    await router.push('/settings/model').catch(() => undefined)
    return
  }
  if (surface === 'permissions') {
    await router.push('/settings/general').catch(() => undefined)
    return
  }
  if (surface === 'plan') {
    await activatePlan()
    return
  }
  if (surface === 'goal') {
    await activateGoalCapture()
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
  refreshAll,
  openCommandSurface,
  activateTransitionedSession,
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
  refreshCommands: loadCommands,
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
  </template>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
