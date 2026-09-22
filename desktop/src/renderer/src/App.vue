<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type {
  CommandCompletion,
  CommandDescriptor,
  CommandSurface,
} from '@emperor/core/api'
import AppFrame from './components/shell/AppFrame.vue'
import SidebarRoot from './components/sidebar/SidebarRoot.vue'
import { useSubagentCounts } from './components/sidebar/subagentCounts'
import { workspaceSourcesFromSnapshot } from './components/details/detailsSources'
import { useLazySessionConversation } from './composables/useLazySessionConversation'
import { useSettingsRoute } from './components/settings/useSettingsRoute'
import Toast from './components/ui/Toast.vue'
import { sessionLocation } from './router'
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
import { activeGoalForSession, hasProjectedGoal } from './runtime/selectors'
import { normalizeGoal } from './runtime/handlers/goals'
import { isTerminalGoal, type GoalCardAction } from './runtime/goalRender'
import { shouldFollowActiveSession } from './runtime/routeFollow'
import type { GoalOperationResult, RuntimeGoalView, SessionInfo } from './types'

// The details column (git / files / xterm) and the settings modal are heavy
// and not needed for first paint: split them out of the initial chunk.
const DetailsPanel = defineAsyncComponent(
  () => import('./components/details/DetailsPanel.vue'),
)
const SettingsModal = defineAsyncComponent(
  () => import('./components/settings/SettingsModal.vue'),
)

const router = useRouter()
const route = useRoute()
const settingsRoute = useSettingsRoute()
const subagentCounts = useSubagentCounts()
const toast = ref('')
const toastOpen = ref(false)
const modelSetupPromptOpen = ref(false)
const modelSetupDismissed = ref(false)
const commandDescriptors = ref<CommandDescriptor[]>([])

function showToast(message: string) {
  toast.value = message
  toastOpen.value = Boolean(message)
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
  configContent,
  mcpContent,
  loadBootstrap,
  refreshMemory,
  startProfileInterview: startProfileInterviewBase,
  skipProfileInterview: skipProfileInterviewBase,
  compactMemory,
  loadConfig,
  saveConfig,
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
  onSubagentEvent: (owner) => subagentCounts.schedule(owner),
})
const {
  queuedPrompts,
  queueDraftRecovery,
  clearQueueDraftRecovery,
  pendingInteractionsBySession,
  busy,
  status,
  switchSession,
  pending,
  goalProjection,
  setSessionGoal,
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
  restoreRuntimeState,
} = runtime

/** The session's goal: live projection first, bootstrap snapshot as fallback. */
const sessionGoal = computed<RuntimeGoalView | null>(() => {
  const owner = sessionId.value
  if (hasProjectedGoal(goalProjection, owner))
    return activeGoalForSession(goalProjection, owner)
  return normalizeGoal(boot.value?.goals?.active)
})

/** The current non-terminal goal (a completed goal no longer drives the UI). */
const currentGoal = computed<RuntimeGoalView | null>(() => {
  const goal = sessionGoal.value
  return goal && !isTerminalGoal(goal) ? goal : null
})

function applyGoalResult(owner: string, result: GoalOperationResult) {
  setSessionGoal(owner, result.goal)
  if (boot.value && owner === sessionId.value)
    boot.value.goals = { active: result.goal }
}

async function startGoal(objective: string): Promise<GoalOperationResult> {
  const owner = sessionId.value
  const draft = sessionStore.isDraftSessionId(owner)
    ? sessionStore.getSession(owner)
    : null
  const result = await core('goals.start', {
    objective,
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
  applyGoalResult(sessionId.value, result)
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
  const owner = sessionId.value
  const result =
    action === 'pause'
      ? await core('goals.pause', goalId)
      : action === 'resume'
        ? await core('goals.resume', goalId)
        : await core('goals.cancel', goalId, reason)
  applyGoalResult(owner, result)
  showToast(
    action === 'pause'
      ? 'Goal 已暂停'
      : action === 'resume'
        ? 'Goal 已恢复'
        : 'Goal 已清除',
  )
  return result
}

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  if (sessionStore.isDraftSessionId(id)) return
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreRuntimeState()
}

async function openProfileInterviewSession(sessionId: string | null) {
  if (!sessionId) return
  await sessionStore.load()
  await onSessionActivate(sessionId)
  await router.push(sessionLocation(sessionId)).catch(() => undefined)
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
    restoreRuntimeState,
    connectSocket,
  })
  startupDone.value = true
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
  const draftId = sessionId.value
  const draft = sessionStore.getSession(draftId)
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
  // Same promotion path as a first message: swap the draft row in place so the
  // route watcher follows to the real session instead of losing the draft id.
  sessionStore.promoteDraft(draftId, created)
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
  await router.push(sessionLocation(session.id)).catch(() => undefined)
  await loadCommands()
}

async function openCommandSurface(
  surface: CommandSurface,
  _params: Record<string, unknown> = {},
): Promise<void> {
  if (surface === 'model' || surface === 'reasoning') {
    await settingsRoute.openSettings('model')
    return
  }
  if (surface === 'permissions') {
    await settingsRoute.openSettings('general')
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
  await settingsRoute.openSettings('model')
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
  controlSessionId: () => sessionStore.backendSessionId() || null,
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
    const goal = sessionGoal.value
    if (!goal || goal.id !== previous.goalId || !isTerminalGoal(goal)) return
    void reconcileTerminalGoal(previous.goalId).then((result) => {
      if (!result.ok && result.error) showToast(result.error)
    })
  },
)

// ── route ⇄ active session ───────────────────────────────────────────────
// /chat/:sessionId is the source of truth for which conversation is shown.
// Known sessions (sidebar list + drafts) activate the runtime; unknown ids
// are child (subagent) sessions viewed read-only by ConversationView. The
// route follows back when the active session moves — see routeFollow.ts for
// the draft-promotion case.
const routeSessionId = computed(() => {
  const raw = route.params.sessionId
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
})
const startupDone = ref(false)
let activating: string | null = null

async function syncRouteSession(): Promise<void> {
  if (!startupDone.value) return
  if (route.name !== 'chat' && route.name !== 'trajectory') return
  const target = routeSessionId.value
  const active = sessionStore.activeId.value
  if (!target) {
    if (active)
      await router
        .replace({ ...(sessionLocation(active) as object), query: route.query })
        .catch(() => undefined)
    return
  }
  if (target === activating) return
  // The sidebar store and the runtime each track an active session; creating
  // a draft only moves the store. Activate unless BOTH already point here, or
  // sends would still go to the previously active runtime session.
  if (target === active && target === sessionId.value) return
  if (!sessionStore.getSession(target)) return
  activating = target
  try {
    await onSessionActivate(target)
  } finally {
    activating = null
  }
}

watch([routeSessionId, startupDone], () => void syncRouteSession())
watch(
  () => sessionStore.activeId.value,
  (active) => {
    if (!startupDone.value) return
    if (route.name !== 'chat' && route.name !== 'trajectory') return
    if (
      !shouldFollowActiveSession({
        routeSessionId: routeSessionId.value,
        activeId: active ?? '',
        routeSessionKnown: Boolean(
          routeSessionId.value && sessionStore.getSession(routeSessionId.value),
        ),
        routeSessionIsDraft: sessionStore.isDraftSessionId(
          routeSessionId.value,
        ),
      })
    )
      return
    void router
      .replace({
        ...(sessionLocation(
          active,
          route.name === 'trajectory' ? 'trajectory' : 'chat',
        ) as object),
        query: route.query,
      })
      .catch(() => undefined)
  },
)

// The details column follows the active session's raw-log conversation
// (Environment sources; workspace refresh as the transcript grows).
const activeConversation = useLazySessionConversation(() => sessionId.value)
const detailsSources = computed(() =>
  workspaceSourcesFromSnapshot(activeConversation.value?.snapshot.value),
)
const detailsRefreshKey = computed(
  () => activeConversation.value?.order.value.length ?? 0,
)
/** Session of the active Trajectory tab (the details inspector follows it). */
const trajectorySessionId = computed(() =>
  route.name === 'trajectory' ? routeSessionId.value : '',
)

function openChildSession(childId: string): void {
  void router.push(sessionLocation(childId)).catch(() => undefined)
}

const activeSessionInfo = computed(() =>
  sessionStore.getSession(sessionId.value),
)

provideAppContext({
  boot,
  loading,
  error,
  configContent,
  mcpContent,
  queuedPrompts,
  queueDraftRecovery,
  clearQueueDraftRecovery,
  pendingInteractionsBySession,
  busy,
  status,
  pending,
  goalProjection,
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
  loadConfig,
  saveConfig,
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
  <div v-if="loading" class="boot-screen">
    <div class="boot-card" role="status">
      <span class="boot-dot" />正在连接本地智能体服务
    </div>
  </div>

  <div v-else-if="error" class="boot-screen">
    <div class="boot-card boot-error" role="alert">
      <strong>桌面端启动失败</strong>
      <p>{{ error }}</p>
      <button type="button" class="boot-retry" @click="refreshAll">
        重新连接
      </button>
    </div>
  </div>

  <template v-else>
    <AppFrame>
      <template #sidebar="{ collapsed, width, toggle }">
        <SidebarRoot :collapsed="collapsed" :width="width" @toggle="toggle" />
      </template>
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
      <template #details>
        <DetailsPanel
          :session-id="sessionId"
          :project-path="activeSessionInfo?.project_path || ''"
          :sources="detailsSources"
          :agent-busy="busy"
          :refresh-key="detailsRefreshKey"
          :trajectory-session-id="trajectorySessionId"
          @open-subagent="openChildSession"
        />
      </template>
    </AppFrame>
    <SettingsModal />
    <ModelSetupRequiredDialog
      :open="modelSetupPromptOpen"
      :message="modelSetupMessage"
      @close="closeModelSetupPrompt"
      @configure="configureModelFromPrompt"
    />
  </template>

  <Toast v-model:open="toastOpen" :message="toast" />
</template>

<style scoped>
.boot-screen {
  display: grid;
  place-items: center;
  height: 100dvh;
  background: rgb(var(--bg-base));
  color: rgb(var(--label-secondary));
}

.boot-card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 420px;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-takeover);
  background: rgb(var(--bg-layer-1));
  box-shadow: var(--shadow-lv2);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  text-align: center;
}

.boot-card:not(.boot-error) {
  flex-direction: row;
}

.boot-dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--accent-fill));
  animation: ds-fade-in 1s ease-in-out infinite alternate;
}

.boot-error strong {
  color: rgb(var(--label-primary));
  font-size: var(--fs-base);
  font-weight: 500;
}

.boot-error p {
  margin: 0;
  color: rgb(var(--danger));
  word-break: break-word;
}

.boot-retry {
  height: calc(var(--space-8) + var(--space-1));
  padding: 0 var(--space-3-5);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--button-primary-fill));
  color: rgb(var(--button-primary-fg));
  font-size: var(--fs-s);
  cursor: pointer;
}
</style>
