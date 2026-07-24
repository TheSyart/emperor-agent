<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import SessionSidebar from './components/layout/SessionSidebar.vue'
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
import type { GoalOperationResult, RuntimeGoalSummary } from './types'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined
const hideAppSidebar = computed(
  () => router.currentRoute.value.meta?.hideAppSidebar === true,
)
const modelSetupPromptOpen = ref(false)
const modelSetupDismissed = ref(false)

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
  clearChat,
  addLocalCommand,
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

async function listGoals(): Promise<RuntimeGoalSummary[]> {
  if (sessionStore.isDraftSessionId(sessionId.value)) return []
  const goals = await core('goals.list', { sessionId: sessionId.value })
  for (const goal of goals) applyGoalSummary(goal)
  return goals
}

async function getGoal(goalId: string): Promise<RuntimeGoalSummary> {
  const goal = await core('goals.get', goalId)
  applyGoalSummary(goal)
  return goal
}

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
  buildSlashPaletteItems(boot.value?.skills || []),
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
})

onBeforeUnmount(() => disposeRuntime())

async function refreshAll() {
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    connectSocket()
    showToast('工作台已刷新')
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
  configContent,
  busy,
  pending,
  routeName: () => router.currentRoute.value.name?.toString() || 'chat',
  runtimeText,
  eventTransportText,
  sendMessage,
  addLocalCommand,
  clearChat,
  stopActive,
  compactMemory,
  restoreMemoryVersion,
  refreshAll,
  showToast,
  currentGoal: () => currentGoal.value,
  startGoal,
  listGoals,
  getGoal,
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
  clearChat,
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
