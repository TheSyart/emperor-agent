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
import ImageViewerHost from './components/ui/ImageViewerHost.vue'
import {
  CENTER_MIN_CHAT,
  CENTER_MIN_TRAJECTORY,
} from './components/shell/columns'
import {
  frameActions,
  useFrameState,
  type WorkspacePane,
} from './components/shell/frameState'
import {
  goBack,
  goForward,
  installNavHistory,
} from './components/shell/navHistory'
import SidebarRoot from './components/sidebar/SidebarRoot.vue'
import { useAgentTree } from './components/sidebar/agentTree'
import { bindWorkspaceSnapshotSource } from './components/workspace/useWorkspaceSnapshot'
import {
  openWorkspacePane,
  toggleWorkspacePane,
} from './components/workspace/workspaceState'
import { useLazySessionConversation } from './composables/useLazySessionConversation'
import { useUiPreferences } from './composables/useUiPreferences'
import { trajectoryOffLocation } from './components/conversation/trajectoryGate'
import { useShortcuts } from './composables/useShortcuts'
import { useSettingsRoute } from './components/settings/useSettingsRoute'
import {
  pushToast,
  showErrorToast,
  visibleToasts,
  type ToastOptions,
} from './components/ui/toasts'
import { activeConfirm } from './components/ui/confirm'
import { isConversationRoute, sessionLocation } from './router'
import { shouldShowModelSetupPrompt } from './components/onboarding/modelSetupDialogModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import { createCommandCatalogLoader } from './commandCatalog'
import {
  onBrowserPairingRequest,
  onBrowserReveal,
  onMenuCommand,
} from './api/backend'
import { core } from './api/http'
import { fetchSessionLineage } from './api/sessions'
import {
  createRouteOwnerController,
  routeOwnerFromLineage,
} from './runtime/routeOwner'
import { useBootstrap } from './composables/useBootstrap'
import { useNotifications } from './composables/useNotifications'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useTokens } from './composables/useTokens'
import { useSlashCommands } from './composables/useSlashCommands'
import { createGoalStarter } from './composables/goalStart'
import { createGoalCaptureController } from './composables/goalCapture'
import { provideAppContext } from './composables/useAppContext'
import { followPluginList } from './composables/pluginListSync'
import { activeGoalForSession, hasProjectedGoal } from './runtime/selectors'
import { normalizeGoal } from './runtime/handlers/goals'
import { isTerminalGoal, type GoalCardAction } from './runtime/goalRender'
import {
  isStaleDraftRoute,
  shouldFollowActiveSession,
} from './runtime/routeFollow'
import { draftSessionOf } from './runtime/sessionDrafts'
import {
  notificationFromNotice,
  type RuntimeNotice,
} from './runtime/notifications'
import type { GoalOperationResult, RuntimeGoalView, SessionInfo } from './types'

// The right workspace (git / files / xterm panes) and the settings modal are
// heavy and not needed for first paint: split them out of the initial chunk.
const WorkspacePanel = defineAsyncComponent(
  () => import('./components/workspace/WorkspacePanel.vue'),
)
const SettingsModal = defineAsyncComponent(
  () => import('./components/settings/SettingsModal.vue'),
)
// Shown only while no model is configured.
const ModelSetupRequiredDialog = defineAsyncComponent(
  () => import('./components/onboarding/ModelSetupRequiredDialog.vue'),
)
// The confirm() dialog loads on the first request (confirm.ts queues it).
// The toast stack's view loads with the first toast (the queue is eager).
const ToastStack = defineAsyncComponent(
  () => import('./components/ui/ToastStack.vue'),
)
const ConfirmHost = defineAsyncComponent(
  () => import('./components/ui/ConfirmHost.vue'),
)

const router = useRouter()
const route = useRoute()
const settingsRoute = useSettingsRoute()
const agentTree = useAgentTree()
const modelSetupPromptOpen = ref(false)
const modelSetupDismissed = ref(false)
const commandDescriptors = ref<CommandDescriptor[]>([])

function showToast(message: string, options?: ToastOptions) {
  pushToast(message, options)
}

function showError(error: unknown, context?: string) {
  showErrorToast(error, context)
}

function closeModelSetupPrompt() {
  modelSetupDismissed.value = true
  modelSetupPromptOpen.value = false
}

const bootstrap = useBootstrap(showToast, {
  onSessionUnavailable: (sessionId) => void leaveUnavailableSession(sessionId),
})
const sessionStore = useSession()
const notifications = useNotifications()
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
  showError,
  resolveDraftSession: sessionStore.getSession,
  onSessionCreated: sessionStore.applySessionCreatedEvent,
  onSessionTitleUpdated: sessionStore.applySessionTitleUpdatedEvent,
  onSessionControlPendingChanged: sessionStore.applySessionControlPending,
  refreshSessions: sessionStore.load,
  onAgentTreeChanged: (event) => agentTree.handleEvent(event),
  onNotify: (notice) => notifyFromRuntime(notice),
})
const {
  queuedPrompts,
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

const startGoal = createGoalStarter({
  currentSessionId: () => sessionId.value,
  draftFor: (id) =>
    sessionStore.isDraftSessionId(id) ? sessionStore.getSession(id) : null,
  start: (request) => core('goals.start', request),
  apply: applyGoalResult,
})

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
  // The goal belongs to the session on screen; name it (KRN-01).
  const result =
    action === 'pause'
      ? await core('goals.pause', goalId, owner)
      : action === 'resume'
        ? await core('goals.resume', goalId, owner)
        : await core('goals.cancel', goalId, reason, owner)
  applyGoalResult(owner, result)
  showToast(
    action === 'pause'
      ? '目标已暂停'
      : action === 'resume'
        ? '目标已恢复'
        : '目标已清除',
  )
  return result
}

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  // The start page shows its draft's own plan mode and preset, never the
  // previous chat's plan or goal (FIX-13).
  if (sessionStore.isDraftSessionId(id)) {
    const { showDraftControls } = await import('./runtime/draftControls')
    return showDraftControls(
      boot,
      () => (sessionId.value === id ? sessionStore.getSession(id) : undefined),
      () => core('control.get', null),
    )
  }
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreRuntimeState()
}

/**
 * The session was archived or deleted elsewhere (its bootstrap failed and a
 * plain one worked): go to the most recent session and say so (FIX-03).
 */
async function leaveUnavailableSession(sessionId: string): Promise<void> {
  showToast('这个会话已归档或不存在，已回到最近的会话')
  await sessionStore.load().catch(() => undefined)
  const next = sessionStore.sessions.value.find(
    (item) => !item.draft && item.id !== sessionId,
  )
  await router
    .push(next ? sessionLocation(next.id) : { name: 'chat' })
    .catch(() => undefined)
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
  // REL-03: an older Emperor than last time, or a restore just applied.
  // Loaded after start-up, outside the first-load budget.
  void import('./appDataNotices').then(({ showDataNotices }) =>
    showDataNotices({
      load: () => core('storage.versions'),
      toast: pushToast,
      openStorage: () => void settingsRoute.openSettings('advanced', 'storage'),
    }),
  )
  await loadCommands()
})

onBeforeUnmount(() => disposeRuntime())

// Plugins change from other pages too (their switches, installs): keep the
// list the composer and message chips read current.
const stopPluginList = followPluginList(boot)
onBeforeUnmount(stopPluginList)

async function refreshAll() {
  // A failed refresh toasts and keeps the shell (useBootstrap, FIX-03).
  if (!(await loadBootstrap(false, sessionStore.backendSessionId()))) return
  connectSocket()
  await loadCommands()
  showToast('工作台已刷新')
}

/**
 * 「重新连接」 on the start-failure screen: a plain bootstrap (never the
 * session that failed), then every open conversation reread from its tail,
 * since live events may have been missed meanwhile (FIX-03).
 */
async function reconnect() {
  if (!(await bootstrap.retry())) return
  restoreRuntimeState()
  connectSocket()
  // The conversation store stays in the chat chunk (first-load budget).
  const { defaultConversationStore } = await import('./conversation/store')
  await defaultConversationStore().resyncAll()
  await loadCommands()
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
  const { mode, project, ...settings } = draftSessionOf(draft)
  const created = await core('sessions.create', {
    title: draft?.title || '新会话',
    mode,
    project: mode === 'build' ? project : null,
    ...settings,
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
    showError(err)
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
  draftId: () =>
    sessionStore.backendSessionId() ? null : sessionStore.activeId.value,
  updateDraft: sessionStore.updateDraft,
  sendMessage,
  ensureCommands: (timeoutMs) =>
    commandDescriptors.value.length
      ? Promise.resolve()
      : Promise.race([
          loadCommands(),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]),
  refreshAll,
  openCommandSurface,
  activateTransitionedSession,
  showToast,
  showError,
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
/** 显示轨迹 (UI-S09): the route follows into the trajectory only when on. */
const { preferences: uiPrefs } = useUiPreferences()
const routeOwner = createRouteOwnerController({
  resolve: async (target) => {
    if (sessionStore.getSession(target)) return target
    if (target.startsWith('dlg-') || target.startsWith('dgr-')) return undefined
    const cached = Object.values(agentTree.trees)
      .map((tree) => tree.byId[target])
      .find(Boolean)
    if (cached && sessionStore.getSession(cached.rootSessionId))
      return cached.rootSessionId
    return routeOwnerFromLineage(
      target,
      await fetchSessionLineage(target),
      (id) => Boolean(sessionStore.getSession(id)),
    )
  },
  activate: onSessionActivate,
  isActive: (owner) =>
    owner === sessionStore.activeId.value && owner === sessionId.value,
})
async function syncRouteSession(): Promise<void> {
  if (!startupDone.value || !isConversationRoute(route.name)) {
    routeOwner.cancel()
    return
  }
  const target = routeSessionId.value
  const staleDraft = isStaleDraftRoute({
    routeSessionId: target,
    routeSessionKnown: Boolean(target && sessionStore.getSession(target)),
    routeSessionIsDraft: sessionStore.isDraftSessionId(target),
  })
  if (!target || staleDraft) {
    routeOwner.cancel()
    const active = sessionStore.activeId.value
    if (active)
      await router
        .replace({ ...(sessionLocation(active) as object), query: route.query })
        .catch(() => undefined)
    return
  }
  await routeOwner.sync(target)
}

watch(
  [routeSessionId, () => route.name, startupDone],
  () => void syncRouteSession(),
)
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
          route.name === 'trajectory' && uiPrefs.value.showTrajectory
            ? 'trajectory'
            : 'chat',
        ) as object),
        query: route.query,
      })
      .catch(() => undefined)
  },
)

// ── notifications (sidebar bell) ────────────────────────────────────────
// The session on screen: the routed one on Chat / Trajectory, none on full
// pages or while the window is hidden. Its questions and finished turns are
// not news (runtime/notifications.ts attention policy).
const viewedSessionId = computed(() =>
  isConversationRoute(route.name)
    ? routeSessionId.value || sessionId.value
    : '',
)

function windowHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  )
}

function notifyFromRuntime(notice: RuntimeNotice): void {
  const hidden = windowHidden()
  const input = notificationFromNotice(notice, {
    sessionTitle: (id) => sessionStore.getSession(id)?.title || '',
    viewedSessionId: hidden ? '' : viewedSessionId.value,
    schedulerPageOpen: !hidden && route.name === 'scheduler',
  })
  if (input) notifications.add(input)
}

// Opening a session (or returning to the window showing it) reads its
// notifications.
watch(viewedSessionId, (id) => notifications.markSessionRead(id), {
  immediate: true,
})

function onVisibilityChange(): void {
  if (!windowHidden()) notifications.markSessionRead(viewedSessionId.value)
}
onMounted(() =>
  document.addEventListener('visibilitychange', onVisibilityChange),
)
onBeforeUnmount(() =>
  document.removeEventListener('visibilitychange', onVisibilityChange),
)

// ── shell: workspace snapshot, columns, shortcuts ───────────────────────
// The shared workspace snapshot follows the active session, so leaving the
// chat for a full page or opening a read-only child log keeps the browser,
// terminal and Files tabs. The viewed session (a child log) is passed along
// so Files still accepts the files that log opens.
const activeConversation = useLazySessionConversation(() => sessionId.value)
bindWorkspaceSnapshotSource({
  sessionId: () => sessionId.value,
  projectPath: () =>
    sessionStore.getSession(sessionId.value)?.project_path || '',
  refreshKey: () => activeConversation.value?.order.value.length ?? 0,
  viewedSessionId: () => viewedSessionId.value,
})

const frame = useFrameState()

// 轨迹门控 (UI-S09): turning 显示轨迹 off leaves the trajectory at once
// (an open settings modal stays) and folds its inspector column, whose
// width waits for the next time.
watch(
  () => uiPrefs.value.showTrajectory,
  (shown) => {
    if (shown) return
    frameActions.closeInspector(frame)
    const target = trajectoryOffLocation(route)
    if (target) void router.replace(target).catch(() => undefined)
  },
)

/** Full-page routes (scheduler, plugins, …) have no workspace column. */
const workspaceAvailable = computed(() => isConversationRoute(route.name))
const centerMin = computed(() =>
  route.name === 'trajectory' ? CENTER_MIN_TRAJECTORY : CENTER_MIN_CHAT,
)
const sidebar = ref<{ focusSearch: () => void } | null>(null)

const stopNavHistory = installNavHistory(router)
onBeforeUnmount(stopNavHistory)

async function newChatFromShortcut(): Promise<void> {
  const session = await sessionStore.create({ mode: 'chat', title: '新会话' })
  await router.push(sessionLocation(session.id)).catch(() => undefined)
}

function workspaceShortcut(pane?: WorkspacePane): () => void {
  return () => {
    if (workspaceAvailable.value) toggleWorkspacePane(pane)
  }
}

useShortcuts({
  'workspace.review': workspaceShortcut('review'),
  'workspace.terminal': workspaceShortcut('terminal'),
  'workspace.files': workspaceShortcut('files'),
  'workspace.browser': workspaceShortcut('browser'),
  'workspace.toggle': workspaceShortcut(),
  'envCard.toggle': () => frameActions.toggleEnvCard(frame),
  'sidebar.toggle': () => frameActions.toggleSidebar(frame),
  'session.new': () => runSafely(newChatFromShortcut),
  search: () => sidebar.value?.focusSearch(),
  'nav.back': () => goBack(router),
  'nav.forward': () => goForward(router),
})

// Main opened a link the user clicked in the built-in browser (设置 ›
// 浏览器): show the 浏览器 pane, back in the session when the link came from
// a full page (a pull request, Explore) that has no workspace column.
const stopBrowserReveal = onBrowserReveal(() => {
  openWorkspacePane('browser')
  if (!workspaceAvailable.value)
    void router.push(sessionLocation(sessionId.value)).catch(() => undefined)
})
onBeforeUnmount(stopBrowserReveal)

// An extension asked to pair (设置 › 电脑操作 › Chrome 和 Edge, step 4):
// show that page, where the user compares the code and clicks 允许.
const stopPairingRequests = onBrowserPairingRequest(() => {
  void settingsRoute.openSettings('computer', 'chrome')
})
onBeforeUnmount(stopPairingRequests)

// 应用菜单 › 偏好设置… (⌘,).
const stopMenuCommands = onMenuCommand((command) => {
  if (command === 'open-settings') void settingsRoute.openSettings('general')
})
onBeforeUnmount(stopMenuCommands)

provideAppContext({
  boot,
  loading,
  error,
  configContent,
  mcpContent,
  queuedPrompts,
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
  showError,
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
      <button type="button" class="boot-retry" @click="reconnect">
        重新连接
      </button>
    </div>
  </div>

  <template v-else>
    <AppFrame :workspace-available="workspaceAvailable" :center-min="centerMin">
      <template #sidebar="{ collapsed, width, toggle }">
        <SidebarRoot
          ref="sidebar"
          :collapsed="collapsed"
          :width="width"
          @toggle="toggle"
        />
      </template>
      <router-view v-slot="{ Component }">
        <keep-alive :max="6">
          <component :is="Component" />
        </keep-alive>
      </router-view>
      <template #workspace="{ open }">
        <WorkspacePanel :open="open" :agent-busy="busy" />
      </template>
    </AppFrame>
    <ImageViewerHost :owner="viewedSessionId" />
    <SettingsModal />
    <ModelSetupRequiredDialog
      v-if="modelSetupPromptOpen"
      :open="modelSetupPromptOpen"
      :message="modelSetupMessage"
      @close="closeModelSetupPrompt"
      @configure="configureModelFromPrompt"
    />
  </template>

  <ToastStack v-if="visibleToasts.length" />
  <ConfirmHost v-if="activeConfirm" />
</template>

<style scoped>
.boot-screen {
  display: grid;
  place-items: center;
  height: 100dvh;
  background: rgb(var(--surface-canvas));
  color: rgb(var(--text-2));
}

.boot-card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 420px;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-takeover);
  background: rgb(var(--surface-base));
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
  background: rgb(var(--accent));
  animation: ds-fade-in 1s ease-in-out infinite alternate;
}

.boot-error strong {
  color: rgb(var(--text-1));
  font-size: var(--fs-base);
  font-weight: var(--weight-medium);
}

.boot-error p {
  margin: 0;
  color: rgb(var(--error));
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
