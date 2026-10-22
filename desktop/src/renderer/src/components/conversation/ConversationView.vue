<script setup lang="ts">
/**
 * ConversationView — center column shell (dsh ConversationRoot): header
 * (breadcrumb, 对话 | 轨迹 tabs, environment-card and workspace toggles),
 * the view area (the raw-log ChatTimeline with the turn scrubber, or the
 * trajectory view with its inspector column), the environment card seat
 * (Chat tab, active phase), and the composer seat: docks (changes pill /
 * todo / goal / queue) above the ComposerCard, or a takeover card while an
 * interaction is pending. A blank chat renders the hero phase: the same seat
 * centered with the headline (and, once, the profile-interview offer under
 * the composer, UI-S04), under a slim header that keeps the two toggles.
 *
 * The environment card floats at the top right of the view area. From a
 * 1120px conversation column (container query) the chat body and the
 * composer stack pad their inline end by the card width so nothing sits
 * under it; narrower, it shows only once opened from the header and still
 * reserves its space.
 *
 * The computer-use preview (read-only pictures of the windows and tabs the
 * Agent controls) sits at the bottom right of the view area, below the
 * environment card; from 1120px the chat body pads for it as well,
 * narrower it folds into a chip.
 *
 * A tool row's Inspect opens the trajectory inspector column and routes to
 * `/chat/:id/trajectory?call=<id>`; the trajectory selects that call (paging
 * older history in when needed) and reports `inspect-applied`, which drops
 * the query again. All of it exists only while 设置 › 常规 › 开发者 ›
 * 显示轨迹 is on (UI-S09, trajectoryGate): off, the header has no tabs, the
 * trajectory never loads, and a trajectory link that lands here instead says
 * so in a toast and opens the call's tool row in the chat.
 *
 * Child (subagent) sessions — ids outside the sidebar list whose lineage has
 * ancestors — render the same timeline (live through the watch set), the
 * lineage breadcrumb in the header and a read-only composer with a stop
 * button while the child runs. An id that is neither says 「没有找到这个会话。」:
 * the composer stays, disabled, with the way out as its placeholder, and the
 * docks of the session behind the page go (F1).
 *
 * The subagent status bar (UI-S14, SubagentDock, loaded on first use) sits
 * above the todo dock while the conversation's subagents are at work and
 * none of their rows is on screen (useSubagentDock).
 */
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pluginDetailLocation } from '../../capabilities/pluginChoices'
import type { SessionLineage } from '@emperor/core/runtime-contract'
import { onCoreEvent, openLink, revealReference } from '../../api/backend'
import { core } from '../../api/http'
import { activateModelEntry, setModelReasoningEffort } from '../../api/model'
import { fetchSessionLineage } from '../../api/sessions'
import { deriveComposerPhase } from '../../conversation/composerPhase'
import { EMPTY_CHAT_SNAPSHOT } from '../../conversation/chatSnapshot'
import { useSessionConversation } from '../../composables/useSessionConversation'
import { useUiPreferences } from '../../composables/useUiPreferences'
import { focusCallStep } from '../../conversation/focusCallRetry'
import { useAppContext } from '../../composables/useAppContext'
import { composerLifecycleMode as resolveComposerLifecycleMode } from '../../composables/composerLifecycle'
import { useSession } from '../../composables/useSession'
import { sessionLocation } from '../../router'
import { normalizeGoal } from '../../runtime/handlers/goals'
import { isTerminalGoal, type GoalCardAction } from '../../runtime/goalRender'
import { activeGoalForSession, hasProjectedGoal } from '../../runtime/selectors'
import type {
  ChatSendPayload,
  ModelConfigPayload,
  QueuedPromptItem,
  TodoItem,
} from '../../types'
import ChangesPill from '../composer/ChangesPill.vue'
import ComposerCard from '../composer/ComposerCard.vue'
import GoalBar from '../composer/GoalBar.vue'
import QueueDock from '../composer/QueueDock.vue'
import { draftHandoff, takeDraftHandoff } from '../chat/draftHandoff'
import ChildComposer from '../composer/ChildComposer.vue'
import TodoDock from '../composer/TodoDock.vue'
import { frameActions, useFrameState } from '../shell/frameState'
import { useAgentTree } from '../sidebar/agentTree'
import { requestWorkspace } from '../workspace/workspaceState'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import ChatTimeline from './ChatTimeline.vue'
import type { SubagentRowView } from './subagentRows'
import { useSubagentDock } from './useSubagentDock'
import ConversationHeader from './ConversationHeader.vue'
import EmptyHero from './EmptyHero.vue'
import HeroProfilePrompt from './HeroProfilePrompt.vue'
import {
  conversationCrumbs,
  conversationPhase,
  sessionRunning,
  isChildLineage,
} from './conversationModel'
import { TrajectoryViewAsync } from '../trajectory/lazy'
import { takeTrajectoryNotice, trajectoryNotice } from './trajectoryGate'
import { previewShownTargets } from './computer-use/computerUsePreviewState'
import { createLinkStatusSource, LINK_STATUS_KEY } from './parts/linkStatus'
import TakeoverSeat from './takeover/TakeoverSeat.vue'
import type { ComposerDraft } from '../chat/composerDraft'
import {
  saveComposerDraft,
  takeComposerDraft,
} from '../../composables/useComposerDrafts'
import { isDraftPromotion } from '../../runtime/sessionDrafts'
import { activeTakeover, isTakeoverMinimized } from './takeover/takeoverModel'
import {
  activeTurnTick,
  sameTicks,
  turnTicks,
  type TurnTick,
} from './timelineModel'
import {
  PROVENANCE_LABEL,
  type DisplayResource,
} from './resources/resourceModel'
import type { ResourceRequest } from './resources/resourceEvents'
const ResourceDetails = defineAsyncComponent(
  () => import('./resources/ResourceDetails.vue'),
)
const selectedResource = shallowRef<DisplayResource | null>(null)
const resourceViewActive = ref(true)
onActivated(() => {
  resourceViewActive.value = true
})
onDeactivated(() => {
  resourceViewActive.value = false
  selectedResource.value = null
})

const EnvironmentCard = defineAsyncComponent(
  () => import('./environment/EnvironmentCard.vue'),
)
const ComputerUsePreviewStack = defineAsyncComponent(
  () => import('./computer-use/ComputerUsePreviewStack.vue'),
)
const TurnScrubber = defineAsyncComponent(() => import('./TurnScrubber.vue'))
const SubagentDock = defineAsyncComponent(
  () => import('../composer/SubagentDock.vue'),
)
/** Fewest turns that earn the scrubber. */
const SCRUBBER_MIN_TURNS = 3

const ctx = useAppContext()
const sessionStore = useSession()
const route = useRoute()
const router = useRouter()
const frame = useFrameState()
const settingsRoute = useSettingsRoute()
const { preferences: uiPrefs } = useUiPreferences()
/** 设置 › 常规 › 开发者 › 显示轨迹 (UI-S09). */
const trajectoryShown = computed(() => uiPrefs.value.showTrajectory)

const composer = ref<{
  setDraft: (text: string) => void
  focusInput: () => void
  restoreDraft: (payload: ChatSendPayload) => void
  takeSnapshot: () => ComposerDraft
  applySnapshot: (draft: ComposerDraft | null) => void
} | null>(null)
const timeline = ref<{
  scrollToKey: (key: string) => boolean
  revealCall: (callId: string) => boolean
  revealAgents: (id: string) => boolean
} | null>(null)

// ── session identity / lineage ────────────────────────────────────────────
const routeSessionId = computed(() => {
  const raw = route.params.sessionId
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
})
const viewingId = computed(() => routeSessionId.value || ctx.sessionId.value)
const knownSession = computed(() => sessionStore.getSession(viewingId.value))
/** A draft has no session log yet: never open a transcript window for it. */
const viewingDraft = computed(() =>
  sessionStore.isDraftSessionId(viewingId.value),
)
const lineage = ref<SessionLineage | null>(null)
const lineageLoading = ref(false)
let lineageGeneration = 0

watch(
  [viewingId, () => Boolean(knownSession.value)],
  async ([id, known]) => {
    const generation = ++lineageGeneration
    if (!id || known || sessionStore.isDraftSessionId(id)) {
      lineage.value = null
      lineageLoading.value = false
      return
    }
    lineageLoading.value = true
    try {
      const result = await fetchSessionLineage(id)
      if (generation === lineageGeneration) lineage.value = result
    } catch {
      if (generation === lineageGeneration) lineage.value = null
    } finally {
      if (generation === lineageGeneration) lineageLoading.value = false
    }
  },
  { immediate: true },
)

const child = computed(
  () => !knownSession.value && isChildLineage(lineage.value),
)
const unknownSession = computed(
  () =>
    Boolean(viewingId.value) &&
    !knownSession.value &&
    !child.value &&
    viewingId.value !== ctx.sessionId.value,
)
// The switch turning off shows the chat at once; App.vue moves the route.
const tab = computed<'chat' | 'trajectory'>(() =>
  route.name === 'trajectory' && trajectoryShown.value ? 'trajectory' : 'chat',
)
/** Raw-log conversation of the viewed session (null for drafts). */
const conversation = useSessionConversation(() => viewingId.value)
const snapshot = computed(
  () => conversation.value?.snapshot.value ?? EMPTY_CHAT_SNAPSHOT,
)
/** Sessions a prompt was submitted from (sticky; drives 'engaging'). */
const promptedSessions = ref(new Set<string>())
// A draft's first prompt promotes it to a real session and the route follows:
// carry the flag over, or the view drops back to the empty hero until the log
// arrives.
watch(viewingId, (next, previous) => {
  if (!previous || !sessionStore.isDraftSessionId(previous)) return
  if (!promptedSessions.value.has(previous) || promptedSessions.value.has(next))
    return
  promptedSessions.value = new Set([...promptedSessions.value, next])
})
const isActiveSession = computed(() => viewingId.value === ctx.sessionId.value)
/** A turn is open in the viewed window (its own ref: not every snapshot). */
const conversationRunning = computed(
  () => conversation.value?.running.value ?? false,
)
/** The composer and TurnStatus read the same running state (FIX-03). */
const runningHere = computed(() =>
  sessionRunning({
    windowOpen:
      conversation.value?.sessionId === viewingId.value &&
      conversation.value.window.value.openState === 'open',
    logRunning: conversationRunning.value,
    active: isActiveSession.value,
    runtimeBusy: ctx.busy.value,
  }),
)
const composerPhase = computed(() =>
  deriveComposerPhase({
    content: {
      rows: conversation.value?.order.value.length ?? 0,
      turns: conversation.value?.turnCount.value ?? 0,
      running: conversationRunning.value,
    },
    promptAttempted: promptedSessions.value.has(viewingId.value),
    pendingInteraction:
      isActiveSession.value && Boolean(pendingInteraction.value),
    busy: runningHere.value,
  }),
)
// Durable external tasks remain useful even when this chat has no visible messages.
const externalActivity = ref(false)
let externalActivityGeneration = 0
watch(
  viewingId,
  async (id) => {
    const generation = ++externalActivityGeneration
    externalActivity.value = false
    if (!id || sessionStore.isDraftSessionId(id)) return
    try {
      const tasks = await core('tasks.list', { sessionId: id })
      if (generation === externalActivityGeneration)
        externalActivity.value = tasks.some(
          (task) => task.kind === 'external-agent',
        )
    } catch {
      /* an unavailable optional task feature does not block chat */
    }
  },
  { immediate: true },
)
const unsubscribeExternalActivity = onCoreEvent((input) => {
  if (!input || typeof input !== 'object') return
  const event = input as Record<string, unknown>
  if (
    event.session_id === viewingId.value &&
    String(event.event).startsWith('delegation_')
  ) {
    externalActivity.value = true
    if (
      event.event === 'delegation_run_changed' ||
      event.event === 'delegation_receipt'
    )
      linkStatus.refresh()
  }
})
onBeforeUnmount(() => {
  externalActivityGeneration++
  unsubscribeExternalActivity()
})
const agentTree = useAgentTree()
const owningRootId = computed(
  () => lineage.value?.chain[0]?.sessionId ?? viewingId.value,
)
const phase = computed(() =>
  conversationPhase({
    composer: composerPhase.value,
    externalActivity:
      externalActivity.value ||
      Boolean(agentTree.trees[owningRootId.value]?.agents.length),
    child: child.value || unknownSession.value,
    tab: tab.value,
    historyState:
      viewingId.value &&
      !viewingDraft.value &&
      (!promptedSessions.value.has(viewingId.value) ||
        (knownSession.value?.message_count ?? 0) > 0)
        ? conversation.value?.sessionId === viewingId.value
          ? conversation.value.window.value.openState
          : 'cold'
        : undefined,
  }),
)
const crumbs = computed(() =>
  conversationCrumbs({
    sessionId: viewingId.value,
    session: knownSession.value,
    lineage: lineage.value,
    titleOf: (id) => sessionStore.getSession(id)?.title,
  }),
)
const parentCrumb = computed(() =>
  child.value ? crumbs.value.at(-2) : undefined,
)
const workspaceOpen = computed(() => frameActions.workspaceOpen(frame))
/** Environment card on screen: Chat tab, active phase, a session to show. */
const envCardShown = computed(
  () =>
    tab.value === 'chat' &&
    frameActions.envCardVisible(frame) &&
    Boolean(viewingId.value) &&
    phase.value !== 'hero',
)
/**
 * Column width from which the card sits beside the chat and shows by
 * default (the `@container conversation (min-width: 1120px)` rule below).
 */
const ENV_CARD_INLINE_MIN = 1120
const rootElement = ref<HTMLElement | null>(null)
let widthObserver: ResizeObserver | null = null
function reportWidth(): void {
  const width = rootElement.value?.clientWidth ?? 0
  if (width > 0)
    frameActions.setEnvCardWide(frame, width >= ENV_CARD_INLINE_MIN)
}
onMounted(() => {
  reportWidth()
  if (typeof ResizeObserver === 'undefined' || !rootElement.value) return
  widthObserver = new ResizeObserver(reportWidth)
  widthObserver.observe(rootElement.value)
})
// Kept alive: the view shown again reports its own column.
onActivated(reportWidth)
onBeforeUnmount(() => widthObserver?.disconnect())
/** The computer-use preview seat: Chat tab, active phase, a root session. */
const cuPreviewSeat = computed(
  () =>
    tab.value === 'chat' &&
    phase.value === 'active' &&
    Boolean(viewingId.value) &&
    !viewingDraft.value &&
    !child.value,
)
const cuPreviewShown = computed(
  () => cuPreviewSeat.value && previewShownTargets().value.size > 0,
)
/** A question or card waits for the user in the viewed session. */
const awaitingUser = computed(() =>
  Boolean(viewingId.value && ctx.pendingInteractionsBySession[viewingId.value]),
)
/** A persisted Build session bound to a project (git rows, changes pill). */
const buildSession = computed(
  () =>
    knownSession.value?.mode === 'build' &&
    Boolean(knownSession.value.project_path) &&
    !viewingDraft.value,
)
const agentBusyHere = runningHere

// ── turn scrubber ─────────────────────────────────────────────────────────
/** Topmost visible chat row (ChatTimeline `first-visible`). */
const firstVisibleKey = ref<string | null>(null)
watch(viewingId, () => {
  firstVisibleKey.value = null
})
// A structural flush that leaves the prompts as they are keeps the same
// array, so the scrubber does not re-render.
const ticks = computed<TurnTick[]>((previous) => {
  const next = turnTicks(snapshot.value)
  return previous !== undefined && sameTicks(previous, next) ? previous : next
})
const activeTick = computed(() =>
  activeTurnTick(ticks.value, snapshot.value.order, firstVisibleKey.value),
)

/** Reveal a chat row (scrubber tick, environment-card plan row). */
function revealRow(key: string): void {
  timeline.value?.scrollToKey(key)
}

function navigate(sessionId: string): void {
  void router.push(sessionLocation(sessionId, tab.value)).catch(() => undefined)
}

function switchTab(next: 'chat' | 'trajectory'): void {
  if (next === tab.value || !viewingId.value) return
  void router
    .push({
      ...(sessionLocation(viewingId.value, next) as object),
      query: route.query,
    })
    .catch(() => undefined)
}

function toggleWorkspace(): void {
  frameActions.toggleWorkspace(frame)
}

function toggleEnvCard(): void {
  frameActions.toggleEnvCard(frame)
}

function closeEnvCard(): void {
  frameActions.setEnvCard(frame, false)
}

function backToParent(): void {
  const target = parentCrumb.value?.sessionId
  if (target) navigate(target)
}

// ── composer inputs ───────────────────────────────────────────────────────
const modelEntries = computed(() => ctx.boot.value?.modelConfig?.models || [])
const currentModel = computed(
  () => ctx.boot.value?.modelConfig?.current || null,
)
const providerOptions = computed(
  () => ctx.boot.value?.modelConfig?.providerOptions || [],
)
/** The composer's placeholder while there is no session here to act on (F1). */
const composerUnavailableReason = computed(() =>
  !unknownSession.value
    ? ''
    : lineageLoading.value
      ? '正在读取会话…'
      : '没有找到这个会话，请从侧栏打开其他会话',
)
const sendBlockedReason = computed(() => {
  const availability = ctx.boot.value?.modelConfig?.availability
  return availability?.usable === false
    ? availability.message || '还没有可用模型，请先配置模型。'
    : ''
})
const pendingInteraction = computed(
  () => ctx.pendingInteractionsBySession[ctx.sessionId.value] || null,
)
// On 「没有找到这个会话」 the takeover, goal and queue docks would act on the
// session behind the page: they go, and the composer shows disabled (F1).
const takeover = computed(() =>
  unknownSession.value ? null : activeTakeover(pendingInteraction.value),
)
/** A takeover card in the composer seat (folded with Esc, it gives the seat back). */
const takeoverOpen = computed(
  () =>
    takeover.value !== null &&
    !isTakeoverMinimized(takeover.value.interaction.id),
)
const activeGoal = computed(() => {
  const owner = ctx.sessionId.value
  const goal = hasProjectedGoal(ctx.goalProjection, owner)
    ? activeGoalForSession(ctx.goalProjection, owner)
    : normalizeGoal(ctx.boot.value?.goals?.active)
  return goal && !isTerminalGoal(goal) ? goal : null
})
const goalCaptureStatus = computed(() =>
  ctx.goalCaptureState.value.sessionId === ctx.sessionId.value
    ? ctx.goalCaptureState.value.status
    : 'idle',
)
const composerLifecycleMode = computed(() =>
  resolveComposerLifecycleMode(
    ctx.boot.value?.control,
    activeGoal.value,
    goalCaptureStatus.value,
  ),
)
const goalActionPending = ref<GoalCardAction | null>(null)
const latestTodos = computed<TodoItem[]>(
  () => snapshot.value.todos as TodoItem[],
)
const projectName = computed(() =>
  knownSession.value?.mode === 'build'
    ? knownSession.value.project_name || ''
    : '',
)

// ── document links in replies ──────────────────────────────────────────────
/** What reply file links point at in the active session (MarkdownHtml). */
const linkStatus = createLinkStatusSource(
  (href, sourceMessageId) =>
    core('references.resolve', {
      sessionId: viewingId.value,
      sourceMessageId: sourceMessageId || viewingId.value,
      href,
      label: href,
    }),
  async (reference) => {
    if (!reference.id) return null
    const image = await core('references.image', {
      sessionId: viewingId.value,
      referenceId: reference.id,
    })
    return image.kind === 'image' &&
      !image.truncated &&
      image.dataBase64 &&
      /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType)
      ? `data:${image.mimeType};base64,${image.dataBase64}`
      : null
  },
)
provide(LINK_STATUS_KEY, linkStatus)
// Files come and go: check again for a new session and after each turn.
watch(viewingId, () => linkStatus.refresh())
watch(
  () => ctx.busy.value,
  (busy, wasBusy) => {
    if (wasBusy && !busy) linkStatus.refresh()
  },
)

// ── window events from commands / markdown links ─────────────────────────
async function resolveMarkdownReference(event: Event): Promise<void> {
  const detail = (
    event as CustomEvent<{
      href?: string
      label?: string
      sourceMessageId?: string
      uses?: { nodeKey: string; label: string }[]
    }>
  ).detail
  if (!detail?.href || !viewingId.value || !resourceViewActive.value) return
  const owner = viewingId.value
  try {
    const reference = await core('references.resolve', {
      sessionId: owner,
      sourceMessageId: detail.sourceMessageId || 'markdown',
      href: detail.href,
      label: detail.label || detail.href,
    })
    if (owner !== viewingId.value || !resourceViewActive.value) return
    linkStatus.record(detail.href, reference, detail.sourceMessageId)
    if (!reference.available) return
    if (
      reference.kind === 'project_file' &&
      reference.directory &&
      knownSession.value?.mode === 'build' &&
      reference.actions.includes('open_files')
    ) {
      requestWorkspace({
        pane: 'files',
        directory: reference.relativePath ?? '',
      })
      return
    }
    if (reference.kind !== 'web' && !reference.actions.includes('preview')) {
      // Files outside the session's root are never read into Emperor; they
      // can only be shown in Finder.
      if (reference.actions.includes('reveal'))
        await revealReference({ sessionId: owner, referenceId: reference.id })
      return
    }
    if (reference.kind !== 'web') {
      requestWorkspace({
        pane: 'files',
        file: {
          owner,
          target: {
            source: 'reference',
            sessionId: owner,
            referenceId: reference.id,
          },
          label: reference.label,
          uses: detail.uses,
          ...(reference.line ? { line: reference.line } : {}),
        },
      })
      return
    }
    if (reference.actions.includes('open_external'))
      await openLink(reference.tooltip)
  } catch {
    // A stale or unavailable reference remains inert; chat must stay usable.
  }
}

function setComposerDraftFromCommand(event: Event): void {
  const text = String(
    (event as CustomEvent<{ text?: string }>).detail?.text ?? '',
  )
  if (!text) return
  void nextTick(() => composer.value?.setDraft(text))
}

function resourceRequest(event: Event): ResourceRequest | null {
  const detail = (event as CustomEvent<ResourceRequest>).detail
  if (
    !resourceViewActive.value ||
    !viewingId.value ||
    !detail?.resource ||
    (detail.sessionId && detail.sessionId !== viewingId.value)
  )
    return null
  return detail
}
function showResourceDetails(event: Event) {
  const detail = resourceRequest(event)
  if (!detail) return
  if (['file', 'folder', 'image', 'attachment'].includes(detail.resource.kind))
    void openDisplayResource(detail.resource)
  else selectedResource.value = detail.resource
}
async function openDisplayResource(resource: DisplayResource): Promise<void> {
  if (['skill', 'plugin', 'mcp'].includes(resource.kind)) {
    const id = resource.href.slice(resource.href.indexOf(':') + 1)
    selectedResource.value = null
    await router.push(
      resource.kind === 'skill'
        ? { path: '/capabilities/skills', query: { skill: id } }
        : resource.kind === 'plugin'
          ? { path: '/capabilities/plugins', query: { plugin: id } }
          : { path: '/capabilities/mcp' },
    )
    return
  }
  const uses = resource.uses?.map((use) => ({
    nodeKey: use.nodeKey,
    label: PROVENANCE_LABEL[use.provenance],
  }))
  if (resource.attachmentId) {
    selectedResource.value = null
    requestWorkspace({
      pane: 'files',
      file: {
        owner: viewingId.value,
        target: { source: 'attachment', attachmentId: resource.attachmentId },
        uses,
      },
    })
    return
  }
  await resolveMarkdownReference(
    new CustomEvent('emperor:resolve-reference', {
      detail: {
        href: resource.href,
        label: resource.label,
        sourceMessageId: resource.sourceMessageId,
        uses,
      },
    }),
  )
}
function openResourceRequest(event: Event) {
  const detail = resourceRequest(event)
  if (detail) void openDisplayResource(detail.resource)
}
function openInternalResource() {
  const github = selectedResource.value?.github
  if (!github?.repo) return
  const [owner, repo] = github.repo.split('/')
  const base =
    github.type === 'pull_request'
      ? '/pulls'
      : github.type === 'issue'
        ? '/github/issues'
        : '/github/ci'
  const id = github.number ?? github.runId
  selectedResource.value = null
  void router.push(
    `${base}/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${id}`,
  )
}
function revealFileSource(event: Event) {
  const detail = (event as CustomEvent<{ owner: string; nodeKey: string }>)
    .detail
  if (resourceViewActive.value && detail.owner === viewingId.value)
    revealRow(detail.nodeKey)
}
function revealResource(nodeKey: string) {
  selectedResource.value = null
  revealRow(nodeKey)
}
watch(viewingId, () => {
  selectedResource.value = null
})

onMounted(() => {
  window.addEventListener('emperor:resolve-reference', resolveMarkdownReference)
  window.addEventListener('emperor:file-source', revealFileSource)
  window.addEventListener('emperor:resource-detail', showResourceDetails)
  window.addEventListener('emperor:resource-open', openResourceRequest)
  window.addEventListener(
    'emperor:set-composer-draft',
    setComposerDraftFromCommand,
  )
})

onBeforeUnmount(() => {
  window.removeEventListener('emperor:file-source', revealFileSource)
  window.removeEventListener('emperor:resource-detail', showResourceDetails)
  window.removeEventListener('emperor:resource-open', openResourceRequest)
  window.removeEventListener(
    'emperor:resolve-reference',
    resolveMarkdownReference,
  )
  window.removeEventListener(
    'emperor:set-composer-draft',
    setComposerDraftFromCommand,
  )
})

watch(
  () => takeover.value?.interaction.id || '',
  (interactionId, previousInteractionId) => {
    if (!previousInteractionId || interactionId) return
    void nextTick(() => composer.value?.focusInput())
  },
)

// A draft another page handed over (plugin 「立即试用」): fill it, never send it.
watch(
  [() => draftHandoff.value, () => ctx.sessionId.value],
  ([handoff, ownerSessionId]) => {
    if (!handoff || handoff.sessionId !== ownerSessionId) return
    void nextTick(() => {
      const text = takeDraftHandoff(ownerSessionId)
      if (text) composer.value?.setDraft(text)
    })
  },
  { flush: 'post', immediate: true },
)

// ── timeline actions ──────────────────────────────────────────────────────
/** Tool-row Inspect: the trajectory's inspector column shows the call. */
function inspectCall(callId: string): void {
  if (!trajectoryShown.value || !viewingId.value || !callId) return
  frameActions.openInspector(frame)
  void router
    .push({
      ...(sessionLocation(viewingId.value, 'trajectory') as object),
      query: { call: callId },
    })
    .catch(() => undefined)
}

function openSubagent(childId: string): void {
  if (childId) navigate(childId)
}

// ── subagent status bar (UI-S14) ──────────────────────────────────────────
const subagentDock = useSubagentDock({
  snapshot: () => snapshot.value,
  sessionId: () => viewingId.value,
  rootSessionId: () => owningRootId.value,
  enabled: () => !child.value && phase.value === 'active',
})

/** A status-bar row: the child's conversation, or the run's page. */
function openAgentRow(row: SubagentRowView): void {
  if (row.agentId === undefined) return
  if (row.backend === 'internal') openSubagent(row.agentId)
  else
    void router
      .push({
        name: 'external-agent',
        params: { sessionId: owningRootId.value, delegationId: row.agentId },
      })
      .catch(() => undefined)
}

function editMessage(text: string): void {
  if (child.value) return
  composer.value?.setDraft(text)
  void nextTick(() => composer.value?.focusInput())
}

/**
 * The composer's send. While the window is still switching to the chat on
 * screen (route ahead of the runtime) nothing is sent: the message would
 * land in the previous chat. `false` puts the draft back.
 */
function sendFromComposer(
  payload: ChatSendPayload,
): boolean | Promise<boolean> {
  const owner = ctx.sessionId.value
  if (routeSessionId.value && routeSessionId.value !== owner) {
    ctx.showToast('正在切换会话，稍后再发送')
    return false
  }
  if (owner && !promptedSessions.value.has(owner))
    promptedSessions.value = new Set([...promptedSessions.value, owner])
  return ctx.submitFromComposer(payload)
}

// Each chat keeps its own unsent draft (text, chips, uploaded files). A
// draft that became its session is the same chat: what was typed while its
// first message went out stays (FIX-13).
watch(
  viewingId,
  (next, previous) => {
    const handle = composer.value
    if (!handle || next === previous || isDraftPromotion(previous, next)) return
    if (previous) saveComposerDraft(previous, handle.takeSnapshot())
    handle.applySnapshot(takeComposerDraft(next))
  },
  { flush: 'pre' },
)

// ── trajectory tab ──────────────────────────────────────────────────────
/** Chat Inspect deep link (`?call=`): the ledger selects and reveals it. */
const focusCallId = computed(() => {
  const raw = route.query.call
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value ? value : null
})

function clearFocusCall(): void {
  if (!focusCallId.value) return
  const { call: _call, ...query } = route.query
  void router.replace({ ...route, query }).catch(() => undefined)
}

// ── trajectory gate (UI-S09) ─────────────────────────────────────────────
// A trajectory link opened while 显示轨迹 is off landed here: say so, and
// open the tool row of the call it pointed at (paging older history in, as
// the trajectory would).
const revealCallId = ref<string | null>(null)
let revealPagesLoaded = 0
watch(
  [() => trajectoryNotice.value, viewingId],
  ([, id], previous) => {
    if (previous?.[1] !== id) revealCallId.value = null
    const notice = takeTrajectoryNotice(id)
    if (notice === null) return
    ctx.showToast('轨迹视图已关闭', {
      action: {
        label: '在设置中开启',
        run: () => void settingsRoute.openSettings('general'),
      },
    })
    revealCallId.value = notice.callId
    revealPagesLoaded = 0
  },
  { immediate: true },
)
watch(
  () =>
    [
      revealCallId.value,
      timeline.value,
      snapshot.value,
      conversation.value?.window.value,
    ] as const,
  ([callId, list, , sessionWindow]) => {
    if (callId === null || list === null || sessionWindow === undefined) return
    if (list.revealCall(callId)) {
      revealCallId.value = null
      return
    }
    const step = focusCallStep(sessionWindow, revealPagesLoaded)
    if (step === 'give-up') revealCallId.value = null
    if (step !== 'load-older') return
    revealPagesLoaded++
    void conversation.value?.loadOlder()
  },
  { flush: 'post' },
)

// ── child session stop ───────────────────────────────────────────────────
const childRunning = computed(() => child.value && conversationRunning.value)
const stoppingChild = ref(false)
watch(childRunning, (running) => {
  if (!running) stoppingChild.value = false
})

// A subagent's own page (AGT-10): the user writes to the child itself, and
// a question it asked is answered here instead of in the main conversation.
const childComposer = ref<InstanceType<typeof ChildComposer> | null>(null)
const childSending = ref(false)
const childSendError = ref('')
const childClosed = ref('')
const childInteraction = computed(() =>
  child.value && viewingId.value
    ? (ctx.pendingInteractionsBySession[viewingId.value] ?? null)
    : null,
)
watch(viewingId, () => {
  childSendError.value = ''
  childClosed.value = ''
})
async function sendToChild(text: string): Promise<void> {
  const id = viewingId.value
  if (!id || childSending.value) return
  childSending.value = true
  childSendError.value = ''
  try {
    await core('agents.send', { sessionId: id, text })
    childComposer.value?.clear()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as { code?: unknown } | null)?.code === 'subagent_not_live')
      childClosed.value = message
    else childSendError.value = message
  } finally {
    childSending.value = false
  }
}

async function stopChild(): Promise<void> {
  const id = viewingId.value
  if (!id || stoppingChild.value) return
  stoppingChild.value = true
  try {
    const cancelled = await core('tasks.cancel', id)
    if (!cancelled) {
      stoppingChild.value = false
      ctx.showToast('子智能体已结束或无法停止')
    }
  } catch (error) {
    stoppingChild.value = false
    ctx.showError(error)
  }
}

async function runGoalStatusAction(action: GoalCardAction): Promise<void> {
  const goal = activeGoal.value
  if (!goal || goalActionPending.value) return
  goalActionPending.value = action
  try {
    await ctx.runGoalAction(goal.id, action)
  } catch (error) {
    ctx.showError(error)
  } finally {
    goalActionPending.value = null
  }
}

/**
 * 编辑 a goal (GoalBar): `/goal edit <objective>` goes into the composer
 * to be changed and sent; Core edits the goal in place (same id, rounds
 * kept).
 */
function editGoal(): void {
  const goal = activeGoal.value
  if (!goal) return
  composer.value?.setDraft(`/goal edit ${goal.objective}`)
}

async function activatePlan(): Promise<void> {
  const result = await ctx.activatePlan()
  if (!result.ok && result.error) ctx.showToast(result.error)
}

async function activateGoalCapture(): Promise<void> {
  const result = await ctx.activateGoalCapture()
  if (!result.ok && result.error) ctx.showToast(result.error)
}

async function startGoalWithLifecycle(outcome: string): Promise<void> {
  try {
    await ctx.startGoalWithLifecycle(outcome)
  } catch (error) {
    ctx.showError(error)
  }
}

/** A plugin picked in the composer that cannot be referenced now: its detail. */
function openPlugin(target: { pluginId: string; scope: string }): void {
  void router.push(pluginDetailLocation(target)).catch(() => undefined)
}

async function dismissLifecycle(): Promise<void> {
  const result = await ctx.dismissLifecycle()
  if (!result.ok && result.error) ctx.showToast(result.error)
}

async function applyModelConfig(payload: ModelConfigPayload): Promise<void> {
  if (!ctx.boot.value) return
  ctx.boot.value.modelConfig = payload
  ctx.boot.value.model = payload.current?.modelId || ''
  ctx.boot.value.provider = payload.current?.provider || undefined
  ctx.boot.value.providerLabel = payload.current?.providerLabel || undefined
  if (payload.profileOnboarding)
    ctx.boot.value.profileOnboarding = payload.profileOnboarding.state
  if (payload.profileOnboarding?.started)
    await ctx.openProfileInterviewSession(
      payload.profileOnboarding.state.sessionId,
    )
}

function switchModel(entryId: string): void {
  const payload = ctx.boot.value?.modelConfig
  if (!payload || payload.current?.entryId === entryId) return
  void ctx.runSafely(async () => {
    await applyModelConfig(await activateModelEntry(entryId))
  })
}

function normalizeReasoningEffort(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function setReasoningEffort(level: string | null): void {
  const payload = ctx.boot.value?.modelConfig
  const activeId = payload?.current?.entryId
  if (!payload || !activeId) return
  const currentEntry = payload.models?.find(
    (entry) => entry.entryId === activeId,
  )
  const currentValue = normalizeReasoningEffort(
    payload.current?.reasoningEffort ?? currentEntry?.reasoningEffort,
  )
  const nextValue = normalizeReasoningEffort(level)
  if (currentValue === nextValue) return
  void ctx.runSafely(async () => {
    await applyModelConfig(
      await setModelReasoningEffort(activeId, nextValue || null),
    )
  })
}

async function editQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  if (!(await ctx.manageQueuedPrompt(item.id, 'cancel'))) return
  composer.value?.restoreDraft(
    item.payload ?? {
      content: item.content,
      attachments: [],
      ...(item.references ? { references: item.references } : {}),
    },
  )
}

async function interjectQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  await ctx.manageQueuedPrompt(item.id, 'interject')
}

async function cancelQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  await ctx.manageQueuedPrompt(item.id, 'cancel')
}

/** 发送 a held prompt (the turn before it failed or was stopped). */
async function sendQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  await ctx.manageQueuedPrompt(item.id, 'send')
}
</script>

<template>
  <section
    ref="rootElement"
    class="conversation-root"
    :data-phase="phase"
    :data-tab="tab"
    :data-env-card="envCardShown || undefined"
    :data-cu-preview="cuPreviewShown || undefined"
    aria-label="对话"
  >
    <ConversationHeader
      :crumbs="crumbs"
      :tab="tab"
      :slim="phase === 'hero'"
      :workspace-open="workspaceOpen"
      :env-card-open="envCardShown"
      :tabs-disabled="!viewingId"
      :trajectory="trajectoryShown"
      @navigate="navigate"
      @tab="switchTab"
      @toggle-workspace="toggleWorkspace"
      @toggle-env-card="toggleEnvCard"
    />

    <div class="view-area">
      <TrajectoryViewAsync
        v-if="tab === 'trajectory' && viewingId"
        :key="viewingId"
        :session-id="viewingId"
        :focus-call-id="focusCallId"
        @inspect-applied="clearFocusCall"
        @open-subagent="openSubagent"
      />
      <div v-else-if="unknownSession" class="child-body">
        <p v-if="lineageLoading" class="child-note">正在读取子会话…</p>
        <p v-else class="child-note">没有找到这个会话。</p>
      </div>
      <div
        v-else-if="phase === 'active' && viewingId && !viewingDraft"
        class="chat-body-slot"
      >
        <ChatTimeline
          ref="timeline"
          :key="viewingId"
          :session-id="viewingId"
          :root-session-id="lineage?.chain[0]?.sessionId ?? viewingId"
          @inspect="inspectCall"
          @open-subagent="openSubagent"
          @edit-message="editMessage"
          @first-visible="firstVisibleKey = $event"
          @agents="subagentDock.report"
        />
        <TurnScrubber
          v-if="ticks.length >= SCRUBBER_MIN_TURNS"
          :ticks="ticks"
          :active="activeTick"
          @select="revealRow"
        />
      </div>

      <!-- Environment card seat (Chat tab): positioned by the card itself. -->
      <EnvironmentCard
        v-if="envCardShown"
        :key="viewingId"
        :session-id="viewingId"
        :root-session-id="owningRootId"
        :native-session-id="child ? viewingId : undefined"
        :snapshot="snapshot"
        :build="buildSession"
        :agent-busy="agentBusyHere"
        :child="child"
        :title="projectName"
        :has-more="conversation?.window.value.hasMore ?? false"
        @reveal="revealRow"
        @open-subagent="openSubagent"
        @close="closeEnvCard"
      />

      <!-- Computer-use preview seat (Chat tab): bottom right, read-only. -->
      <ResourceDetails
        v-if="selectedResource"
        :key="`${viewingId}:${selectedResource.id}`"
        :resource="selectedResource"
        :session-id="viewingId"
        @close="selectedResource = null"
        @open="openDisplayResource(selectedResource)"
        @open-internal="openInternalResource"
        @reveal="revealResource"
      />

      <ComputerUsePreviewStack
        v-if="cuPreviewSeat && viewingId"
        :key="viewingId"
        :session-id="viewingId"
        :awaiting="awaitingUser"
      />
    </div>

    <div v-if="tab === 'chat'" class="composer-seat">
      <EmptyHero v-if="phase === 'hero'" :project-name="projectName" />
      <template v-if="child">
        <TakeoverSeat v-if="childInteraction" :interaction="childInteraction" />
        <ChildComposer
          v-else
          ref="childComposer"
          :parent-title="parentCrumb?.label"
          :running="childRunning"
          :stopping="stoppingChild"
          :sending="childSending"
          :error="childSendError || undefined"
          :closed="childClosed || undefined"
          @send="sendToChild"
          @back="backToParent"
          @root="navigate(lineage?.chain[0]?.sessionId ?? ctx.sessionId.value)"
          @stop="stopChild"
        />
      </template>
      <div v-else class="stack">
        <ChangesPill
          v-if="!takeoverOpen && viewingId"
          :session-id="viewingId"
          :build="buildSession"
        />
        <SubagentDock
          v-if="!takeoverOpen && subagentDock.shown.value"
          :rows="subagentDock.state.value.rows"
          :target="subagentDock.state.value.target"
          :root-session-id="owningRootId"
          @open="openAgentRow"
          @reveal="timeline?.revealAgents($event)"
        />
        <TodoDock v-if="!takeoverOpen" :todos="latestTodos" />
        <GoalBar
          v-if="activeGoal && !unknownSession"
          :goal="activeGoal"
          :action-pending="goalActionPending"
          @action="runGoalStatusAction"
          @edit="editGoal"
        />
        <TakeoverSeat v-if="takeover" :interaction="pendingInteraction" />
        <QueueDock
          v-if="!takeoverOpen && !unknownSession"
          :items="ctx.queuedPrompts.value"
          @edit="editQueuedPrompt"
          @interject="interjectQueuedPrompt"
          @cancel="cancelQueuedPrompt"
          @send="sendQueuedPrompt"
        />
        <ComposerCard
          v-show="!takeoverOpen"
          ref="composer"
          :dictation-chat="ctx.sessionId.value"
          :hero="phase === 'hero'"
          :busy="runningHere"
          :interaction-blocked="Boolean(pendingInteraction)"
          :queue-occupied="Boolean(ctx.queuedPrompts.value.length)"
          :goal="activeGoal"
          :goal-capture-status="goalCaptureStatus"
          :lifecycle-mode="composerLifecycleMode"
          :commands="ctx.commands.value"
          :plugins="ctx.boot.value?.plugins ?? []"
          :context-used="ctx.boot.value?.context_used ?? 0"
          :context-max="
            ctx.boot.value?.modelConfig?.current?.contextWindowTokens ?? 0
          "
          :control="ctx.boot.value?.control || null"
          :current-model="currentModel"
          :model-entries="modelEntries"
          :provider-options="providerOptions"
          :supports-vision="
            ctx.boot.value?.modelConfig?.current?.capabilities?.vision ?? false
          "
          :send-blocked-reason="sendBlockedReason"
          :unavailable-reason="composerUnavailableReason"
          :complete-command="ctx.completeSlashCommand"
          :refresh-commands="ctx.refreshCommands"
          @set-permission="ctx.setPermissionMode"
          @open-plugin="openPlugin"
          @activate-plan="activatePlan"
          @activate-goal="activateGoalCapture"
          @dismiss-lifecycle="dismissLifecycle"
          @start-goal="startGoalWithLifecycle"
          @switch-model="switchModel"
          @set-reasoning-effort="setReasoningEffort"
          @send="sendFromComposer"
          @stop="ctx.stopActive"
          @error="ctx.showToast"
        />
      </div>
      <HeroProfilePrompt
        v-if="phase === 'hero' && !child"
        :session-id="viewingId || ''"
        :blocked="Boolean(pendingInteraction)"
      />
    </div>
  </section>
</template>

<style scoped>
.conversation-root {
  container: conversation / inline-size;
  position: relative;
  --chat-content-width: 748px;
  --env-card-width: min(340px, 42cqi);
  --composer-card-max: calc(var(--chat-content-width) + var(--space-8));
  --composer-clearance: var(--space-4);
  --dock-inset: var(--space-2);
  --composer-stack-gap: var(--space-1-5);

  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.view-area {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/* Every opened card reserves space, including a narrow manual toggle. */
.conversation-root[data-env-card] .chat-body-slot,
.conversation-root[data-env-card] .composer-seat {
  padding-inline-end: calc(var(--env-card-width) + var(--space-4));
}
@container conversation (min-width: 1120px) {
  .conversation-root[data-cu-preview] .chat-body-slot {
    padding-inline-end: calc(var(--env-card-width) + var(--space-4));
  }
}

[data-phase='hero'] .view-area {
  display: none;
}

.chat-body-slot {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-x: hidden;
}

.child-body {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
}

.child-note {
  max-width: 420px;
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--text-3));
  text-align: center;
}

.composer-seat {
  position: relative;
  z-index: var(--z-raised);
  display: flex;
  flex: none;
  flex-direction: column;
  margin-top: calc(0px - var(--space-8) - var(--space-1));
  padding-top: calc(var(--space-8) + var(--space-1));
  background: linear-gradient(
    180deg,
    rgb(var(--surface-base) / 0) 0,
    rgb(var(--surface-base)) calc(var(--space-8) + var(--space-1))
  );
  pointer-events: none;
}

.composer-seat > * {
  pointer-events: auto;
}

[data-phase='hero'] .composer-seat {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin-top: 0;
  padding: 0 0 var(--space-8);
  background: none;
  overflow-y: auto;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--composer-stack-gap);
  width: 100%;
}

[data-phase='hero'] .stack {
  width: min(
    calc(var(--composer-card-max) + 2 * var(--composer-clearance)),
    100%
  );
}
</style>
