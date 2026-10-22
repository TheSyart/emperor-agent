<script setup lang="ts">
/**
 * ChatTimeline — dsh ChatView over the raw-event conversation projection:
 * one keyed, virtualized list (DynamicScroller, page mode inside our own
 * scroller) of timeline rows (processModel): chat nodes, each dispatched by
 * ChatNodeSeat, and one ProcessGroup per turn holding the steps between the
 * prompt and the answer (UI-S03). Content column max 748px centered with the
 * 16px flow gap; bottom-follow while the reader is pinned (a new user row
 * always re-pins); a 34px floating back-to-bottom button otherwise; older
 * pages load when the reader reaches the top, keeping the same row in place;
 * a group the reader opens or folds keeps its line in place. While a turn
 * runs, its live process line is the status line; TurnStatus closes the flow
 * only when there is none (waiting for the first token, the answer
 * streaming).
 *
 * The subagents a step sent out are a row of their own (SubagentGroup,
 * UI-S14); the timeline watches which of those rows are on screen and
 * reports them with the rows (the status bar above the composer shows only
 * while no group at work is in view).
 *
 * Props: sessionId; store? (injected ConversationStore — tests/gallery).
 * Emits: inspect(callId), open-subagent(sessionId), edit-message(text),
 * first-visible(key | null) — the topmost visible row, reported once per
 * frame while the reader scrolls (the turn scrubber's active tick);
 * agents({ groups, visible }) — the subagent rows of the loaded window
 * (`agents:<call key>` and their calls) and the ids of those on screen.
 * Exposes: scrollToBottom(), scrollToKey(key) — reveal a row near the top
 * (the list is virtualized, so rows off screen are reachable only here; a
 * step inside a folded process group opens the group first), revealCall(id)
 * — the same for a tool call's row, opened (a trajectory link while the
 * trajectory is off, UI-S09), revealAgents(id) — scroll to a subagent row
 * and light it up for a moment (「回到列表 ↑」).
 */
import Button from '../ui/Button.vue'
import Spinner from '../ui/Spinner.vue'
import {
  computed,
  effectScope,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowReactive,
  shallowRef,
  watch,
  type EffectScope,
} from 'vue'
// @ts-expect-error vue-virtual-scroller v2 beta 无类型声明（见 shims）
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { conversationContextKey } from '../../conversation/assembler'
import {
  useConversation,
  type ConversationHandle,
  type ConversationStore,
} from '../../conversation/store'
import { DsChevronDown } from '../icons/ds'
import { useUiPreferences } from '../../composables/useUiPreferences'
import ChatNodeSeat from './ChatNodeSeat.vue'
import { createExpansionStore, provideChatContext } from './chatContext'
import TurnStatus from './TurnStatus.vue'
import ConversationLoading from './ConversationLoading.vue'
import ProcessGroup from './nodes/ProcessGroup.vue'
import SubagentGroup from './nodes/SubagentGroup.vue'
import {
  processExpansionKey,
  rowIndexOf,
  rowNodeKey,
  timelineRowsOf,
  type TimelineRow,
} from './processModel'
import type { TimelineAgents } from './subagentRows'
import { isAtBottom, turnStatusLabel } from './timelineModel'

const props = withDefaults(
  defineProps<{
    sessionId: string
    rootSessionId?: string
    store?: ConversationStore
  }>(),
  { store: undefined, rootSessionId: undefined },
)
const emit = defineEmits<{
  inspect: [callId: string]
  'open-subagent': [sessionId: string]
  'edit-message': [text: string]
  'first-visible': [key: string | null]
  agents: [state: TimelineAgents]
}>()

const expansion = createExpansionStore()
/** The turn under the pointer (turn tails show their actions). */
const hoverTurn = ref<number | null>(null)

// ── subagent rows on screen (UI-S14) ────────────────────────────────────
const visibleAgents = shallowReactive(new Set<string>())
const agentTargets = new Map<Element, string>()
let agentObserver: IntersectionObserver | null = null
/** The subagent row lit up after 「回到列表 ↑」. */
const highlightedAgents = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined

function agentsObserver(): IntersectionObserver | null {
  if (agentObserver !== null || typeof IntersectionObserver === 'undefined')
    return agentObserver
  // The viewport root still clips by the scroller (and a recycled view
  // parked off screen reads as hidden).
  agentObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = agentTargets.get(entry.target)
      if (id === undefined) continue
      if (entry.isIntersecting) visibleAgents.add(id)
      else visibleAgents.delete(id)
    }
  })
  return agentObserver
}

function observeAgents(element: Element, id: string): () => void {
  agentTargets.set(element, id)
  agentsObserver()?.observe(element)
  return () => {
    agentObserver?.unobserve(element)
    agentTargets.delete(element)
    if (![...agentTargets.values()].includes(id)) visibleAgents.delete(id)
  }
}

provideChatContext({
  actions: {
    inspect: (callId) => emit('inspect', callId),
    openSubagent: (sessionId) => emit('open-subagent', sessionId),
    editMessage: (text) => emit('edit-message', text),
    holdRow,
  },
  expansion,
  sessionId: () => props.sessionId,
  rootSessionId: () => props.rootSessionId ?? props.sessionId,
  hoverTurn: () => hoverTurn.value,
  agentRows: {
    observe: observeAgents,
    highlighted: () => highlightedAgents.value,
  },
})
const { preferences } = useUiPreferences()

// ── conversation handle (re-opened when the session changes) ────────────
const handle = shallowRef<ConversationHandle | null>(null)
let scope: EffectScope | null = null
watch(
  () => props.sessionId,
  (sessionId) => {
    scope?.stop()
    scope = effectScope()
    handle.value =
      scope.run(() =>
        props.store === undefined
          ? useConversation(sessionId)
          : useConversation(sessionId, props.store),
      ) ?? null
  },
  { immediate: true },
)
onBeforeUnmount(() => scope?.stop())

const order = computed(() => handle.value?.order.value ?? [])
const snapshot = computed(() => handle.value?.snapshot.value)
const windowState = computed(() => handle.value?.window.value)

// Rows are rebuilt per published snapshot (one pass over the order) and
// keep their identity while nothing structural moves, so streaming deltas
// re-render only the rows they touch.
let previousRows: readonly TimelineRow[] | undefined
const rows = computed<readonly TimelineRow[]>(() => {
  const current = snapshot.value
  if (current === undefined) return (previousRows = [])
  previousRows = timelineRowsOf(
    current,
    { showSystemSteps: preferences.value.showSystemSteps },
    previousRows,
  )
  return previousRows
})
const rowIndex = computed(() => rowIndexOf(rows.value))
const itemCache = new WeakMap<TimelineRow, { id: string; row: TimelineRow }>()
const items = computed(() =>
  rows.value.map((row) => {
    let item = itemCache.get(row)
    if (item === undefined) {
      item = { id: row.id, row }
      itemCache.set(row, item)
    }
    return item
  }),
)
const agentGroups = computed(() =>
  rows.value.flatMap((row) =>
    row.kind === 'agents' ? [{ id: row.id, members: [...row.members] }] : [],
  ),
)
watch(
  [agentGroups, () => [...visibleAgents]],
  ([groups, visible]) => emit('agents', { groups, visible }),
  { immediate: true },
)
const running = computed(() => handle.value?.running.value === true)
const liveProcess = computed(() =>
  rows.value.some((row) => row.kind === 'process' && row.live),
)
const statusLabel = computed(() =>
  snapshot.value === undefined ? '' : turnStatusLabel(snapshot.value),
)
const hasMore = computed(() => windowState.value?.hasMore === true)
const loadingOlder = computed(() => windowState.value?.loadingOlder === true)
const openState = computed(() => windowState.value?.openState ?? 'cold')
const openError = computed(() => windowState.value?.error ?? null)
/** Read the history again after a failed read (FIX-03). */
function retryOpen(): void {
  void handle.value?.retry()
}

// ── scrolling ───────────────────────────────────────────────────────────
const scroller = ref<HTMLElement | null>(null)
const column = ref<HTMLElement | null>(null)
const list = ref<{ scrollToItem: (index: number) => void } | null>(null)
const following = ref(true)
/** Last scrollTop we wrote (reader input is anything that deviates). */
let observedTop = 0
let resizeObserver: ResizeObserver | null = null

interface PagingAnchor {
  key: string
  top: number
  until: number
  /** Set by scrollToKey: paging keeps the revealed row, not the top one. */
  reveal?: true
  /** Set by holdRow: following resumes only if the reader is still at the floor. */
  hold?: true
}

/** Offset (px) a revealed row keeps below the scroller top (its padding). */
const REVEAL_OFFSET = 16

const nextFrame: (callback: () => void) => unknown =
  typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 16)
let anchor: PagingAnchor | null = null

function pinToBottom(): void {
  const el = scroller.value
  if (el === null) return
  el.scrollTop = el.scrollHeight
  observedTop = el.scrollTop
}

function scrollToBottom(): void {
  following.value = true
  anchor = null
  pinToBottom()
}

function rowTop(row: HTMLElement, el: HTMLElement): number {
  return row.getBoundingClientRect().top - el.getBoundingClientRect().top
}

function findRow(key: string): HTMLElement | null {
  const host = column.value
  if (host === null) return null
  for (const row of host.querySelectorAll<HTMLElement>(
    '[data-chat-anchor-key]',
  ))
    if (row.dataset.chatAnchorKey === key) return row
  return null
}

function captureAnchor(): PagingAnchor | null {
  const el = scroller.value
  const host = column.value
  if (el === null || host === null) return null
  const top = el.getBoundingClientRect().top
  for (const row of host.querySelectorAll<HTMLElement>(
    '[data-chat-anchor-key]',
  )) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > top && row.dataset.chatAnchorKey !== undefined)
      return {
        key: row.dataset.chatAnchorKey,
        top: rect.top - top,
        until: Date.now() + 1500,
      }
  }
  return null
}

function restoreAnchor(): void {
  const el = scroller.value
  if (el === null || anchor === null) return
  if (Date.now() > anchor.until) {
    if (anchor.hold) following.value = isAtBottom(el)
    anchor = null
    return
  }
  const row = findRow(anchor.key)
  if (row === null) return
  const delta = rowTop(row, el) - anchor.top
  if (Math.abs(delta) > 0.5) {
    el.scrollTop += delta
    observedTop = el.scrollTop
  }
}

function loadOlder(): void {
  const current = handle.value
  if (current === null || !hasMore.value || loadingOlder.value) return
  if (!anchor?.reveal || Date.now() > anchor.until) anchor = captureAnchor()
  void current.loadOlder().finally(() => {
    void nextTick(restoreAnchor)
  })
}

function onScroll(): void {
  const el = scroller.value
  if (el === null) return
  const floor = Math.max(0, el.scrollHeight - el.clientHeight)
  const movedByReader =
    Math.abs(el.scrollTop - Math.min(observedTop, floor)) > 0.5
  if (movedByReader) {
    following.value = isAtBottom(el)
    if (!following.value && anchor !== null && Date.now() > anchor.until)
      anchor = null
  }
  observedTop = el.scrollTop
  if (el.scrollTop < 160 && !following.value) loadOlder()
  reportFirstVisible()
}

/**
 * Keep row `key` at its place on screen while its height changes (a group
 * the reader opens or folds, animating for 200ms).
 */
function holdRow(key: string): void {
  const el = scroller.value
  const row = findRow(key)
  if (el === null || row === null) return
  following.value = false
  anchor = { key, top: rowTop(row, el), until: Date.now() + 600, hold: true }
}

// ── first visible row / reveal ──────────────────────────────────────────
let visibleQueued = false
let lastVisibleKey: string | null | undefined

/** The chat node a row anchor stands for (a process group: its first step). */
function nodeKeyOf(anchorKey: string): string {
  const index = rowIndex.value.get(anchorKey)
  const row = index === undefined ? undefined : rows.value[index]
  return row?.id === anchorKey ? rowNodeKey(row) : anchorKey
}

function reportFirstVisible(): void {
  if (visibleQueued) return
  visibleQueued = true
  nextFrame(() => {
    visibleQueued = false
    const anchorKey = captureAnchor()?.key
    const key = anchorKey === undefined ? null : nodeKeyOf(anchorKey)
    if (key === lastVisibleKey) return
    lastVisibleKey = key
    emit('first-visible', key)
  })
}

/** Open the folded group (process, subagents) holding node `key`. */
function openGroupOf(key: string): void {
  const index = rowIndex.value.get(key)
  const row = index === undefined ? undefined : rows.value[index]
  if (row === undefined || row.kind === 'node' || row.id === key) return
  if (row.kind === 'agents') {
    expansion.set(row.id, true)
    return
  }
  const { key: expansionKey } = processExpansionKey(
    row,
    preferences.value.processDisplay,
  )
  expansion.set(expansionKey, true)
}

/**
 * Reveal the row `key` near the top. A rendered row scrolls directly; an
 * off-screen one goes through the virtual list first, then the paging anchor
 * settles it as the rows around it render and measure. False when the key is
 * not in the loaded window.
 */
function scrollToKey(key: string): boolean {
  const el = scroller.value
  const index = rowIndex.value.get(key) ?? -1
  if (el === null || index < 0) return false
  openGroupOf(key)
  following.value = false
  anchor = { key, top: REVEAL_OFFSET, until: Date.now() + 1500, reveal: true }
  const row = findRow(key) ?? findRow(rows.value[index]?.id ?? key)
  if (row !== null) {
    el.scrollTop += rowTop(row, el) - REVEAL_OFFSET
    observedTop = el.scrollTop
  } else list.value?.scrollToItem(index)
  nextFrame(() => {
    restoreAnchor()
    nextFrame(restoreAnchor)
  })
  reportFirstVisible()
  return true
}

/**
 * Reveal the tool row of call `callId` near the top and open it. Its row key
 * is the engine's Context key of the call; false while the call is not in
 * the loaded window.
 */
function revealCall(callId: string): boolean {
  const key = conversationContextKey('tool', callId)
  if (snapshot.value?.nodes.get(key)?.kind !== 'tool') return false
  if (!rowIndex.value.has(key)) return false
  expansion.set(`tool:${callId}`, true)
  return scrollToKey(key)
}

/**
 * Scroll to the subagent row `id` and light it up for a moment (the status
 * bar's 「回到列表 ↑」). False when the row is not in the loaded window.
 */
function revealAgents(id: string): boolean {
  if (rows.value[rowIndex.value.get(id) ?? -1]?.kind !== 'agents') return false
  if (!scrollToKey(id)) return false
  highlightedAgents.value = id
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedAgents.value = null
  }, 1600)
  return true
}

function onContentResize(): void {
  if (anchor !== null) restoreAnchor()
  else if (following.value) pinToBottom()
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && column.value !== null) {
    resizeObserver = new ResizeObserver(onContentResize)
    resizeObserver.observe(column.value)
  }
  pinToBottom()
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  agentObserver?.disconnect()
  clearTimeout(highlightTimer)
})

// New flow content: follow while pinned; the reader's own message re-pins.
let lastKey: string | undefined
watch(
  order,
  (next) => {
    const tip = next.at(-1)
    const appended = tip !== undefined && tip !== lastKey
    lastKey = tip
    if (
      appended &&
      tip !== undefined &&
      handle.value?.snapshot.value.nodes.get(tip)?.kind === 'user'
    )
      following.value = true
    if (anchor !== null) {
      void nextTick(restoreAnchor)
      return
    }
    if (following.value) void nextTick(pinToBottom)
    reportFirstVisible()
  },
  { flush: 'post' },
)
watch(
  () => [openState.value, running.value] as const,
  () => {
    if (following.value) void nextTick(pinToBottom)
  },
  { flush: 'post' },
)
watch(
  () => props.sessionId,
  () => {
    following.value = true
    anchor = null
    lastKey = undefined
    lastVisibleKey = undefined
    hoverTurn.value = null
    highlightedAgents.value = null
    void nextTick(pinToBottom)
  },
)

// ── hovered turn ────────────────────────────────────────────────────────
function onPointerOver(event: Event): void {
  const target = event.target
  const seat =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-chat-turn]')
      : null
  const turn = seat?.dataset.chatTurn
  hoverTurn.value = turn === undefined || turn === '' ? null : Number(turn)
}

defineExpose({ scrollToBottom, scrollToKey, revealCall, revealAgents })
</script>

<template>
  <div class="chat-timeline" :data-session-id="sessionId">
    <div
      ref="scroller"
      class="scroller"
      data-conversation-scroll
      @scroll.passive="onScroll"
    >
      <div
        ref="column"
        class="column"
        data-chat-flow
        @pointerover="onPointerOver"
        @pointerleave="hoverTurn = null"
      >
        <div v-if="hasMore || loadingOlder" class="older">
          <span v-if="loadingOlder" class="older-loading" role="status">
            <Spinner size="sm" />
            正在加载更早的消息…
          </span>
          <button v-else type="button" class="older-button" @click="loadOlder">
            加载更早的消息
          </button>
        </div>
        <ConversationLoading
          v-if="
            (openState === 'cold' || openState === 'opening') &&
            order.length === 0
          "
        />
        <div v-if="openError" class="open-error" role="alert">
          <span>会话记录读取失败：{{ openError }}</span>
          <Button size="sm" variant="secondary" @click="retryOpen">重试</Button>
        </div>
        <DynamicScroller
          ref="list"
          class="list"
          :items="items"
          key-field="id"
          :min-item-size="24"
          :buffer="800"
          page-mode
        >
          <template #default="{ item, active }">
            <DynamicScrollerItem :item="item" :active="active">
              <template v-if="handle">
                <ProcessGroup
                  v-if="item.row.kind === 'process'"
                  :handle="handle"
                  :row="item.row"
                />
                <SubagentGroup
                  v-else-if="item.row.kind === 'agents'"
                  :handle="handle"
                  :row="item.row"
                />
                <ChatNodeSeat
                  v-else
                  :handle="handle"
                  :node-key="item.id"
                  :closing="item.row.closing === true"
                  :part="item.row.answerOnly ? 'answer' : undefined"
                />
              </template>
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
        <TurnStatus
          v-if="running && !liveProcess"
          :label="statusLabel"
          :started-at="snapshot?.turnStatus?.startedAt ?? null"
        />
      </div>
      <div v-if="!following && order.length > 0" class="to-bottom-slot">
        <button
          type="button"
          class="to-bottom"
          aria-label="回到底部"
          @click="scrollToBottom"
        >
          <DsChevronDown :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-timeline {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* Spans the conversation region: its scrollbar is at the far right, under
   a floating card. `--chat-shift` (ConversationView, UI-S16) moves the
   centred column left of a card without narrowing it. */
.scroller {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--space-4) var(--space-8) calc(var(--space-8) + var(--space-6));
  padding-inline-end: calc(var(--space-8) + 2 * var(--chat-shift, 0px));
  overflow-anchor: none;
}

.column {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--chat-content-width, 748px);
  margin: 0 auto;
}

.list {
  width: 100%;
}

.list :deep(.vue-recycle-scroller__item-view) {
  width: 100%;
}

.older {
  display: flex;
  justify-content: center;
  padding-bottom: var(--space-4);
}

.older-button {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-pill);
  background: var(--surface-hover-solid);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.older-loading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.open-error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-block: var(--space-6) var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--r-md);
  background: rgb(var(--error-soft));
  color: rgb(var(--text-1));
  font: var(--font-xs);
}

.open-error span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Zero-height sticky slot: the button never extends scrollHeight; its right
   edge is the column's, wherever the column sits. */
.to-bottom-slot {
  position: sticky;
  bottom: calc(var(--space-8) + var(--space-5));
  z-index: var(--z-raised);
  display: flex;
  justify-content: flex-end;
  height: 0;
  padding-right: max(0px, calc((100% - var(--chat-content-width, 748px)) / 2));
  pointer-events: none;
}

.to-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-top: calc(0px - var(--space-8) - var(--space-0-5));
  padding: 0;
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--surface-raised));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--text-1));
  cursor: pointer;
  pointer-events: auto;
}

.to-bottom:hover {
  background: var(--surface-hover-solid);
}
</style>
