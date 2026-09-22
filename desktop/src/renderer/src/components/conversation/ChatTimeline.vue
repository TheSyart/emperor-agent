<script setup lang="ts">
/**
 * ChatTimeline — dsh ChatView over the raw-event conversation projection:
 * one keyed, virtualized list (DynamicScroller, page mode inside our own
 * scroller) of chat nodes, each dispatched by ChatNodeSeat; content column
 * max 748px centered with the 16px flow gap; bottom-follow while the
 * reader is pinned (a new user row always re-pins); a 34px floating
 * back-to-bottom button otherwise; older pages load when the reader reaches
 * the top, keeping the same row in place; TurnStatus closes the flow while
 * a turn runs.
 *
 * Props: sessionId; store? (injected ConversationStore — tests/gallery).
 * Emits: inspect(callId), open-subagent(sessionId), edit-message(text).
 */
import {
  computed,
  effectScope,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type EffectScope,
} from 'vue'
// @ts-expect-error vue-virtual-scroller v2 beta 无类型声明（见 shims）
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import {
  useConversation,
  type ConversationHandle,
  type ConversationStore,
} from '../../conversation/store'
import { DsChevronDown, DsLoading } from '../icons/ds'
import ChatNodeSeat from './ChatNodeSeat.vue'
import { createExpansionStore, provideChatContext } from './chatContext'
import TurnStatus from './TurnStatus.vue'
import {
  closingAssistantKeys,
  isAtBottom,
  turnStatusLabel,
} from './timelineModel'

const props = withDefaults(
  defineProps<{ sessionId: string; store?: ConversationStore }>(),
  { store: undefined },
)
const emit = defineEmits<{
  inspect: [callId: string]
  'open-subagent': [sessionId: string]
  'edit-message': [text: string]
}>()

provideChatContext({
  actions: {
    inspect: (callId) => emit('inspect', callId),
    openSubagent: (sessionId) => emit('open-subagent', sessionId),
    editMessage: (text) => emit('edit-message', text),
  },
  expansion: createExpansionStore(),
})

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
const items = computed(() => order.value.map((id) => ({ id })))
const closingKeys = computed(() =>
  snapshot.value === undefined
    ? new Set<string>()
    : closingAssistantKeys(order.value, snapshot.value.nodes),
)
const running = computed(() => snapshot.value?.running === true)
const statusLabel = computed(() =>
  snapshot.value === undefined ? '' : turnStatusLabel(snapshot.value),
)
const hasMore = computed(() => windowState.value?.hasMore === true)
const loadingOlder = computed(() => windowState.value?.loadingOlder === true)
const openState = computed(() => windowState.value?.openState ?? 'cold')
const openError = computed(() => windowState.value?.error ?? null)

// ── scrolling ───────────────────────────────────────────────────────────
const scroller = ref<HTMLElement | null>(null)
const column = ref<HTMLElement | null>(null)
const following = ref(true)
/** Last scrollTop we wrote (reader input is anything that deviates). */
let observedTop = 0
let resizeObserver: ResizeObserver | null = null

interface PagingAnchor {
  key: string
  top: number
  until: number
}
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
  anchor = captureAnchor()
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
onBeforeUnmount(() => resizeObserver?.disconnect())

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
    void nextTick(pinToBottom)
  },
)

defineExpose({ scrollToBottom })
</script>

<template>
  <div class="chat-timeline" :data-session-id="sessionId">
    <div
      ref="scroller"
      class="scroller"
      data-conversation-scroll
      @scroll.passive="onScroll"
    >
      <div ref="column" class="column" data-chat-flow>
        <div v-if="hasMore || loadingOlder" class="older">
          <span v-if="loadingOlder" class="older-loading" role="status">
            <DsLoading :size="14" class="spin" />
            正在加载更早的消息…
          </span>
          <button v-else type="button" class="older-button" @click="loadOlder">
            加载更早的消息
          </button>
        </div>
        <div
          v-if="openState === 'opening' && order.length === 0"
          class="hint"
          role="status"
        >
          正在读取会话记录…
        </div>
        <div v-if="openError" class="open-error" role="alert">
          会话记录读取失败：{{ openError }}
        </div>
        <DynamicScroller
          class="list"
          :items="items"
          key-field="id"
          :min-item-size="24"
          :buffer="800"
          page-mode
        >
          <template #default="{ item, active }">
            <DynamicScrollerItem :item="item" :active="active">
              <ChatNodeSeat
                v-if="handle"
                :handle="handle"
                :node-key="item.id"
                :closing="closingKeys.has(item.id)"
              />
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
        <TurnStatus
          v-if="running"
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

.scroller {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--space-4) var(--space-8) calc(var(--space-8) + var(--space-6));
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
  background: var(--interactive-bg-hover-solid);
  color: rgb(var(--label-secondary));
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
  color: rgb(var(--label-tertiary));
}

.spin {
  animation: chat-timeline-spin 0.9s linear infinite;
}

@keyframes chat-timeline-spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.open-error {
  padding-bottom: var(--space-4);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--danger));
}

/* Zero-height sticky slot: the button never extends scrollHeight. */
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
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--label-primary));
  cursor: pointer;
  pointer-events: auto;
}

.to-bottom:hover {
  background: var(--interactive-bg-hover-solid);
}
</style>
