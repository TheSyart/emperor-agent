<script setup lang="ts">
/**
 * ConversationView — center column shell (dsh ConversationRoot): header
 * (breadcrumb, Chat | Trajectory tabs, details toggle), the view area (the
 * raw-log ChatTimeline or the trajectory view), and the composer seat:
 * docks (todo / goal / queue) above the ComposerCard, or a takeover card
 * while an interaction is pending. A blank chat renders the hero phase: the
 * same seat centered with the headline.
 *
 * Child (subagent) sessions — ids outside the sidebar list whose lineage has
 * ancestors — render the same timeline (live through the watch set), the
 * lineage breadcrumb in the header and a read-only composer with a stop
 * button while the child runs.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { SessionLineage } from '@emperor/core/runtime-contract'
import { openExternal, revealReference } from '../../api/backend'
import { core } from '../../api/http'
import { activateModelEntry, setModelReasoningEffort } from '../../api/model'
import { fetchSessionLineage } from '../../api/sessions'
import { deriveComposerPhase } from '../../conversation/composerPhase'
import { EMPTY_CHAT_SNAPSHOT } from '../../conversation/chatSnapshot'
import { useSessionConversation } from '../../composables/useSessionConversation'
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
import ComposerCard from '../composer/ComposerCard.vue'
import GoalBar from '../composer/GoalBar.vue'
import QueueDock from '../composer/QueueDock.vue'
import ReadOnlyComposer from '../composer/ReadOnlyComposer.vue'
import TodoDock from '../composer/TodoDock.vue'
import { openDetailsTab, requestDetails } from '../details/detailsState'
import { selectCall } from '../details/inspectState'
import { frameActions, useFrameState } from '../shell/frameState'
import Button from '../ui/Button.vue'
import ChatTimeline from './ChatTimeline.vue'
import ConversationHeader from './ConversationHeader.vue'
import EmptyHero from './EmptyHero.vue'
import {
  conversationCrumbs,
  conversationPhase,
  isChildLineage,
} from './conversationModel'
import { TrajectoryViewAsync } from '../trajectory/lazy'
import TakeoverSeat from './takeover/TakeoverSeat.vue'
import { activeTakeover } from './takeover/takeoverModel'

const ctx = useAppContext()
const sessionStore = useSession()
const route = useRoute()
const router = useRouter()
const frame = useFrameState()

const composer = ref<{
  setDraft: (text: string) => void
  focusInput: () => void
  restoreDraft: (payload: ChatSendPayload) => void
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
const tab = computed<'chat' | 'trajectory'>(() =>
  route.name === 'trajectory' ? 'trajectory' : 'chat',
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
const composerPhase = computed(() =>
  deriveComposerPhase({
    snapshot: snapshot.value,
    promptAttempted: promptedSessions.value.has(viewingId.value),
    pendingInteraction:
      isActiveSession.value && Boolean(pendingInteraction.value),
    busy: isActiveSession.value && ctx.busy.value,
  }),
)
const phase = computed(() =>
  conversationPhase({
    composer: composerPhase.value,
    child: child.value || unknownSession.value,
    tab: tab.value,
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
const detailsOpen = computed(() => frame.details > 0)

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

function toggleDetails(): void {
  frameActions.toggleDetails(frame)
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
const sendBlockedReason = computed(() => {
  const availability = ctx.boot.value?.modelConfig?.availability
  return availability?.usable === false
    ? availability.message || '还没有可用模型，请先配置模型。'
    : ''
})
const pendingInteraction = computed(
  () => ctx.pendingInteractionsBySession[ctx.sessionId.value] || null,
)
const takeover = computed(() => activeTakeover(pendingInteraction.value))
const showProfileOnboardingPrompt = computed(
  () =>
    ctx.boot.value?.profileOnboarding?.status === 'pending' &&
    !pendingInteraction.value,
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

// ── window events from commands / markdown links ─────────────────────────
function openWorkspaceFromCommand(event: Event): void {
  const detail = (
    event as CustomEvent<{
      pane?: 'review' | 'terminal' | 'files'
      paths?: string[]
    }>
  ).detail
  if (!detail?.pane) return
  if (detail.pane === 'review')
    requestDetails({ tab: 'git', paths: detail.paths ?? [] })
  else requestDetails({ tab: detail.pane })
}

async function resolveMarkdownReference(event: Event): Promise<void> {
  const detail = (
    event as CustomEvent<{
      href?: string
      label?: string
      sourceMessageId?: string
    }>
  ).detail
  if (!detail?.href || !ctx.sessionId.value) return
  try {
    const reference = await core('references.resolve', {
      sessionId: ctx.sessionId.value,
      sourceMessageId: detail.sourceMessageId || 'markdown',
      href: detail.href,
      label: detail.label || detail.href,
    })
    if (!reference.available) return
    if (
      reference.kind === 'project_file' &&
      reference.relativePath &&
      reference.actions.includes('open_files')
    ) {
      requestDetails({
        tab: 'files',
        file: {
          path: reference.relativePath,
          ...(reference.line ? { line: reference.line } : {}),
        },
      })
      return
    }
    if (
      reference.kind === 'external_file' &&
      reference.actions.includes('reveal')
    ) {
      await revealReference({
        sessionId: ctx.sessionId.value,
        referenceId: reference.id,
      })
      return
    }
    if (reference.actions.includes('open_external'))
      await openExternal(reference.tooltip)
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

onMounted(() => {
  window.addEventListener('emperor:open-workspace', openWorkspaceFromCommand)
  window.addEventListener('emperor:resolve-reference', resolveMarkdownReference)
  window.addEventListener(
    'emperor:set-composer-draft',
    setComposerDraftFromCommand,
  )
})

onBeforeUnmount(() => {
  window.removeEventListener('emperor:open-workspace', openWorkspaceFromCommand)
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

watch(
  [() => ctx.queueDraftRecovery.value, () => ctx.sessionId.value],
  ([recovery, ownerSessionId]) => {
    if (!recovery || recovery.sessionId !== ownerSessionId) return
    void nextTick(() => {
      composer.value?.restoreDraft(recovery.payload)
      ctx.clearQueueDraftRecovery(recovery.sessionId)
    })
  },
  { flush: 'post' },
)

// ── timeline actions ──────────────────────────────────────────────────────
function inspectCall(callId: string): void {
  if (viewingId.value) selectCall(viewingId.value, callId)
}

function openSubagent(childId: string): void {
  if (childId) navigate(childId)
}

function editMessage(text: string): void {
  if (child.value) return
  composer.value?.setDraft(text)
  void nextTick(() => composer.value?.focusInput())
}

function sendFromComposer(payload: ChatSendPayload): void {
  const owner = ctx.sessionId.value
  if (owner && !promptedSessions.value.has(owner))
    promptedSessions.value = new Set([...promptedSessions.value, owner])
  ctx.submitFromComposer(payload)
}

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

/** A selected ledger record shows in the details column's inspector. */
function onTrajectorySelect(recordId: string | null): void {
  if (recordId) openDetailsTab('inspect')
}

// ── child session stop ───────────────────────────────────────────────────
const childRunning = computed(() => child.value && snapshot.value.running)
const stoppingChild = ref(false)
watch(childRunning, (running) => {
  if (!running) stoppingChild.value = false
})

async function stopChild(): Promise<void> {
  const id = viewingId.value
  if (!id || stoppingChild.value) return
  stoppingChild.value = true
  try {
    const cancelled = await core('tasks.cancel', id)
    if (!cancelled) {
      stoppingChild.value = false
      ctx.showToast('子代理已结束或无法停止')
    }
  } catch (error) {
    stoppingChild.value = false
    ctx.showToast(error instanceof Error ? error.message : String(error))
  }
}

async function runGoalStatusAction(action: GoalCardAction): Promise<void> {
  const goal = activeGoal.value
  if (!goal || goalActionPending.value) return
  goalActionPending.value = action
  try {
    await ctx.runGoalAction(goal.id, action)
  } catch (error) {
    ctx.showToast(error instanceof Error ? error.message : String(error))
  } finally {
    goalActionPending.value = null
  }
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
    ctx.showToast(error instanceof Error ? error.message : String(error))
  }
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
  if (await ctx.manageQueuedPrompt(item.id, 'cancel'))
    composer.value?.setDraft(item.content)
}

async function interjectQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  await ctx.manageQueuedPrompt(item.id, 'interject')
}

async function cancelQueuedPrompt(item: QueuedPromptItem): Promise<void> {
  await ctx.manageQueuedPrompt(item.id, 'cancel')
}
</script>

<template>
  <section
    class="conversation-root"
    :data-phase="phase"
    :data-tab="tab"
    aria-label="对话"
  >
    <ConversationHeader
      v-if="phase === 'active'"
      :crumbs="crumbs"
      :tab="tab"
      :details-open="detailsOpen"
      :tabs-disabled="!viewingId"
      @navigate="navigate"
      @tab="switchTab"
      @toggle-details="toggleDetails"
    />

    <div class="view-area">
      <TrajectoryViewAsync
        v-if="tab === 'trajectory' && viewingId"
        :key="viewingId"
        :session-id="viewingId"
        :focus-call-id="focusCallId"
        @select="onTrajectorySelect"
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
          :key="viewingId"
          :session-id="viewingId"
          @inspect="inspectCall"
          @open-subagent="openSubagent"
          @edit-message="editMessage"
        />
      </div>
    </div>

    <div v-if="tab === 'chat'" class="composer-seat">
      <EmptyHero v-if="phase === 'hero'" :project-name="projectName" />
      <ReadOnlyComposer
        v-if="child"
        :parent-title="parentCrumb?.label"
        :running="childRunning"
        :stopping="stoppingChild"
        @back="backToParent"
        @stop="stopChild"
      />
      <div v-else class="stack">
        <div
          v-if="showProfileOnboardingPrompt"
          class="notice-dock"
          role="status"
        >
          <span class="notice-copy">
            <strong>补充个人偏好</strong>
            <span>用一个简短访谈设置称呼、沟通方式和工作偏好。</span>
          </span>
          <Button size="sm" variant="ghost" @click="ctx.skipProfileInterview"
            >不再提醒</Button
          >
          <Button size="sm" variant="accent" @click="ctx.startProfileInterview"
            >开始访谈</Button
          >
        </div>
        <TodoDock v-if="!takeover" :todos="latestTodos" />
        <GoalBar
          v-if="activeGoal"
          :goal="activeGoal"
          :action-pending="goalActionPending"
          @action="runGoalStatusAction"
        />
        <TakeoverSeat v-if="takeover" :interaction="pendingInteraction" />
        <QueueDock
          v-if="!takeover"
          :items="ctx.queuedPrompts.value"
          @edit="editQueuedPrompt"
          @interject="interjectQueuedPrompt"
          @cancel="cancelQueuedPrompt"
        />
        <ComposerCard
          v-show="!takeover"
          ref="composer"
          :hero="phase === 'hero'"
          :busy="ctx.busy.value"
          :interaction-blocked="Boolean(pendingInteraction)"
          :queue-occupied="Boolean(ctx.queuedPrompts.value.length)"
          :goal="activeGoal"
          :goal-capture-status="goalCaptureStatus"
          :lifecycle-mode="composerLifecycleMode"
          :commands="ctx.commands.value"
          :tools="ctx.boot.value?.tools || []"
          :mcp-content="ctx.mcpContent.value"
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
          :complete-command="ctx.completeSlashCommand"
          :refresh-commands="ctx.refreshCommands"
          @set-permission="ctx.setPermissionMode"
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
    </div>
  </section>
</template>

<style scoped>
.conversation-root {
  --chat-content-width: 748px;
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
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
}

.view-area {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
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
  color: rgb(var(--label-tertiary));
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
    rgb(var(--bg-base) / 0) 0,
    rgb(var(--bg-base)) calc(var(--space-8) + var(--space-1))
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

.notice-dock {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: calc(100% - 2 * var(--composer-clearance) - 4 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 4 * var(--dock-inset));
  min-height: 36px;
  margin: 0 auto;
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--tip-fill));
}

.notice-copy {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  white-space: nowrap;
}

.notice-copy strong {
  flex: none;
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.notice-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
