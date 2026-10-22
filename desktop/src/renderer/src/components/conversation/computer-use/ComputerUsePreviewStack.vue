<script setup lang="ts">
/**
 * ComputerUsePreviewStack — bottom right of the chat: a read-only preview of
 * the windows and tabs this session's Agent controls. No controls: the Agent
 * drives, the user watches (stopping stays with the kill switch).
 *
 * - The Agent's latest target is the front card; the others peek above it as
 *   staggered title strips (clicking one only brings it to the front). The
 *   header counts every target.
 * - Live frames reuse the Agent preview channel for at most four targets
 *   (desktop capture streams, built-in browser paint frames); the rest, and
 *   external browser tabs, show their latest tool screenshot with its time.
 *   Sensitive apps and targets that received a credential show no picture.
 *   After the user's "Stop Sharing" a window keeps its last frame, marked.
 * - The front card's picture opens a larger read-only view (Esc returns).
 * - The Agent's pointer: where its latest desktop or built-in browser action
 *   landed, drawn on that target's live picture with the on-screen arrow,
 *   also while the window itself is covered. It glides from point to point
 *   (not when the system reduces motion) and fades out after about 2 s.
 * - From a 1152px conversation region the stack floats beside the chat
 *   (ConversationView moves the column clear of it, as of the environment
 *   card, UI-S16) and publishes the span it takes above the bottom of its
 *   seat, so the card above stops short. Narrower, it folds into a counted
 *   chip that expands over the chat; arrow keys switch cards and Escape
 *   folds it again.
 * - Subscriptions stop and every object URL is released when the stack is
 *   folded, the page is hidden, the view is deactivated or unmounted (a
 *   session switch remounts it by key), so no other session's frame shows.
 *
 * Props: sessionId (the viewed chat), awaiting (a question or card waits for
 * the user in it).
 */
import Badge from '../../ui/Badge.vue'
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import { AppWindow, Globe, ScreenShare } from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import type {
  AgentPreviewError,
  AgentPreviewUpdate,
} from '../../../../../shared/ipc-contract'
import {
  agentPreviewStart,
  agentPreviewStop,
  hasCoreBridge,
  invokeCore,
  onAgentPreviewFrame,
  onAgentPreviewPointer,
  onCoreEvent,
} from '../../../api/backend'
import { useReducedMotion } from '../../../composables/useReducedMotion'
import { openImageViewer } from '../../ui/imageViewer'
import { modalLayerCount } from '../../ui/modalStack'
import {
  POINTER_FADE_MS,
  POINTER_GONE_MS,
  STACK_DEPTH,
  liveTargetIds,
  pickTarget,
  pointerPlacement,
  previewFrame,
  previewSource,
  previewStatus,
  previewTargetsFor,
  previewTitle,
  stackOrder,
  type PreviewFrame,
  type PreviewPick,
} from './computerUsePreviewModel'
import {
  consumePreviewFocus,
  previewFocusRequest,
  previewLayout,
  setPreviewShownTargets,
} from './computerUsePreviewState'

const props = withDefaults(
  defineProps<{ sessionId: string; awaiting?: boolean }>(),
  { awaiting: false },
)

/**
 * Conversation region width from which the stack sits beside the chat
 * (ConversationView's FLOAT_BESIDE_MIN).
 */
const BESIDE_MIN = 1152
/** Gap (px) kept between the stack and the environment card above it. */
const RESERVE_GAP = 12

const status = ref<ComputerUseStatusView | null>(null)
const pick = ref<PreviewPick | null>(null)
const compact = ref(false)
/** The column width is known (no frames stream before it is). */
const measured = ref(false)
const expanded = ref(false)
const pageVisible = ref(
  typeof document === 'undefined' || document.visibilityState !== 'hidden',
)
const activated = ref(true)
const now = ref(new Date())
const root = ref<HTMLElement | null>(null)
const stack = ref<HTMLElement | null>(null)

const targets = computed(() =>
  previewTargetsFor(status.value?.targets, props.sessionId),
)
const ordered = computed(() => stackOrder(targets.value, pick.value))
const front = computed(() => ordered.value[0] ?? null)
/** Strips behind the front card, deepest first (drawn top-down). */
const behind = computed(() => ordered.value.slice(1, STACK_DEPTH).reverse())
const onScreen = computed(
  () =>
    measured.value &&
    pageVisible.value &&
    activated.value &&
    (!compact.value || expanded.value),
)
const liveIds = computed(() =>
  liveTargetIds(ordered.value, { onScreen: onScreen.value }),
)
function statusOf(target: UiTargetView) {
  return previewStatus(target, { awaiting: props.awaiting })
}

function frameOf(target: UiTargetView): PreviewFrame {
  const frame = previewFrame(target, frames.value[target.targetId], now.value)
  const error = previewErrors.value[target.targetId]
  if (error && frame.kind !== 'blocked' && !target.sharingStopped)
    return {
      kind: 'none',
      note:
        error === 'screen-recording-permission-missing'
          ? '需要屏幕录制权限，请在「设置 › 电脑操作」中重新授权'
          : '实时画面暂不可用，请在「设置 › 电脑操作」中检查连接',
    }
  return frame
}

function frameSrc(frame: PreviewFrame): string {
  if (frame.kind === 'live' || frame.kind === 'frozen') return frame.url
  if (frame.kind === 'shot') return attachmentRawUrl(frame.attachmentId)
  return ''
}

function iconOf(target: UiTargetView) {
  return target.driver === 'desktop' ? AppWindow : Globe
}

// --- status --------------------------------------------------------------

let alive = true
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeCore = () => {}

async function refresh(): Promise<void> {
  if (!hasCoreBridge()) return
  try {
    const next = await invokeCore('computerUse.status')
    if (!alive) return
    status.value = next
    now.value = new Date()
  } catch {
    if (alive) status.value = null
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 60)
}

// --- live frames (object URLs) -------------------------------------------

const frames = ref<Record<string, string>>({})
const previewErrors = ref<Record<string, AgentPreviewError>>({})
/** Each live frame's size: the pointer goes on the letterboxed picture. */
const frameSizes = ref<Record<string, { width: number; height: number }>>({})
const streaming = new Map<string, symbol>()
let stopFrames = () => {}

function clearPreviewError(targetId: string): void {
  const { [targetId]: _error, ...rest } = previewErrors.value
  previewErrors.value = rest
}

function dropFrame(targetId: string): void {
  const url = frames.value[targetId]
  if (url === undefined) return
  URL.revokeObjectURL(url)
  const { [targetId]: _dropped, ...rest } = frames.value
  frames.value = rest
  const { [targetId]: _size, ...sizes } = frameSizes.value
  frameSizes.value = sizes
}

function syncLive(): void {
  const wanted = new Set(liveIds.value)
  // A window whose sharing the user stopped keeps its last frame.
  const frozen = new Set(
    targets.value
      .filter((target) => target.sharingStopped === true)
      .map((target) => target.targetId),
  )
  for (const targetId of streaming.keys())
    if (!wanted.has(targetId)) {
      streaming.delete(targetId)
      agentPreviewStop(targetId)
      clearPreviewError(targetId)
      if (!frozen.has(targetId)) dropFrame(targetId)
    }
  for (const targetId of wanted)
    if (!streaming.has(targetId)) {
      const token = Symbol()
      streaming.set(targetId, token)
      const failed = () => {
        if (streaming.get(targetId) === token)
          previewErrors.value = {
            ...previewErrors.value,
            [targetId]: 'preview-unavailable',
          }
      }
      agentPreviewStart(targetId)
        .then((result) => {
          if (!result.ok) failed()
        })
        .catch(failed)
    }
}

function stopAllLive(): void {
  for (const targetId of streaming.keys()) agentPreviewStop(targetId)
  streaming.clear()
  previewErrors.value = {}
  for (const url of Object.values(frames.value)) URL.revokeObjectURL(url)
  frames.value = {}
  frameSizes.value = {}
}

function onFrame(frame: AgentPreviewUpdate): void {
  if (!streaming.has(frame.targetId)) return
  if ('error' in frame) {
    dropFrame(frame.targetId)
    previewErrors.value = {
      ...previewErrors.value,
      [frame.targetId]: frame.error,
    }
    return
  }
  clearPreviewError(frame.targetId)
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(frame.jpeg)], { type: 'image/jpeg' }),
  )
  const previous = frames.value[frame.targetId]
  frames.value = { ...frames.value, [frame.targetId]: url }
  if (previous) URL.revokeObjectURL(previous)
  const size = frameSizes.value[frame.targetId]
  if (size?.width !== frame.width || size?.height !== frame.height)
    frameSizes.value = {
      ...frameSizes.value,
      [frame.targetId]: { width: frame.width, height: frame.height },
    }
}

// --- the Agent's pointer -------------------------------------------------

/** A share (0–1) of the target's picture, and whether it is fading out. */
interface ShownPointer {
  readonly x: number
  readonly y: number
  readonly fading: boolean
}

/** Where the Agent's latest action landed on each target, for about 2 s. */
const pointers = ref<Record<string, ShownPointer>>({})
const pointerTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
const reducedMotion = useReducedMotion()
let stopPointers = () => {}

/** The front card's pointer, placed on its live picture only. */
const frontPointer = computed(() => {
  const target = front.value
  const shown = target ? pointers.value[target.targetId] : undefined
  if (!target || !shown || frameOf(target).kind !== 'live') return null
  return {
    ...pointerPlacement(shown, frameSizes.value[target.targetId]),
    fading: shown.fading,
  }
})

function clearPointerTimers(targetId: string): void {
  for (const timer of pointerTimers.get(targetId) ?? []) clearTimeout(timer)
  pointerTimers.delete(targetId)
}

function forgetPointer(targetId: string): void {
  clearPointerTimers(targetId)
  if (!(targetId in pointers.value)) return
  const { [targetId]: _gone, ...rest } = pointers.value
  pointers.value = rest
}

function forgetPointers(): void {
  for (const timer of [...pointerTimers.values()].flat()) clearTimeout(timer)
  pointerTimers.clear()
  pointers.value = {}
}

function onPointer(pointer: { targetId: string; x: number; y: number }): void {
  const { targetId, x, y } = pointer
  clearPointerTimers(targetId)
  pointers.value = { ...pointers.value, [targetId]: { x, y, fading: false } }
  pointerTimers.set(targetId, [
    setTimeout(() => {
      const shown = pointers.value[targetId]
      if (shown)
        pointers.value = {
          ...pointers.value,
          [targetId]: { ...shown, fading: true },
        }
    }, POINTER_FADE_MS),
    setTimeout(() => forgetPointer(targetId), POINTER_GONE_MS),
  ])
}

// --- interaction ---------------------------------------------------------

function bringForward(targetId: string): void {
  pick.value = pickTarget(targets.value, targetId)
}

function cycle(step: 1 | -1): void {
  const list = ordered.value
  if (list.length < 2) return
  const next = step === 1 ? list[1] : list[list.length - 1]
  if (next) bringForward(next.targetId)
}

async function enlarge(targetId: string): Promise<void> {
  const target = ordered.value.find((target) => target.targetId === targetId)
  if (!target) return
  const frame = frameOf(target)
  const src = frameSrc(frame)
  if (!src) return
  const owner = props.sessionId
  // Clone the already received frame: live preview URLs are revoked on the next frame.
  let snapshot = src
  let dispose: (() => void) | undefined
  if (src.startsWith('blob:')) {
    try {
      const blob = await (await fetch(src)).blob()
      snapshot = URL.createObjectURL(blob)
      dispose = () => URL.revokeObjectURL(snapshot)
    } catch {
      return
    }
  }
  if (owner !== props.sessionId || !activated.value) {
    dispose?.()
    return
  }
  openImageViewer({
    owner,
    dispose,
    items: [
      {
        id: targetId,
        src: snapshot,
        name: previewTitle(target),
        caption: `${statusOf(target).label} · ${frame.note}`,
      },
    ],
  })
}

function onStackKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    event.preventDefault()
    cycle(1)
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault()
    cycle(-1)
  }
}

/** Escape folds the expanded chip (never under a modal). */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (!activated.value || event.key !== 'Escape') return
  if (event.defaultPrevented || event.isComposing) return
  if (!compact.value || !expanded.value || modalLayerCount() > 0) return
  event.preventDefault()
  expanded.value = false
}

function onVisibility(): void {
  pageVisible.value = document.visibilityState !== 'hidden'
}

// --- layout --------------------------------------------------------------

let host: HTMLElement | null = null
let hostObserver: ResizeObserver | null = null
let stackObserver: ResizeObserver | null = null

/**
 * The visible chip or expanded stack reserves its span below the info card:
 * from its top to the bottom of the seat both float in (the view area).
 */
function publishReserve(): void {
  const element = root.value
  const seat = element?.parentElement
  previewLayout.reservedHeight =
    activated.value && host && element && seat && front.value
      ? Math.round(
          seat.getBoundingClientRect().bottom -
            element.getBoundingClientRect().top,
        ) + RESERVE_GAP
      : 0
}

function observeHost(): void {
  const column = root.value?.closest<HTMLElement>('.conversation-root') ?? null
  if (column === host && hostObserver !== null) return
  host = column
  if (!column) return
  const measure = () => {
    compact.value = column.clientWidth < BESIDE_MIN
    measured.value = true
    if (!compact.value) expanded.value = false
    publishReserve()
  }
  measure()
  if (typeof ResizeObserver === 'undefined') return
  hostObserver?.disconnect()
  hostObserver = new ResizeObserver(measure)
  hostObserver.observe(column)
}

function observeStack(): void {
  if (!stack.value || typeof ResizeObserver === 'undefined') return
  stackObserver?.disconnect()
  stackObserver = new ResizeObserver(publishReserve)
  stackObserver.observe(stack.value)
  if (root.value) stackObserver.observe(root.value)
}

// --- wiring --------------------------------------------------------------

watch(liveIds, syncLive)
watch(
  () => ordered.value.map((target) => target.targetId),
  (targetIds) => {
    setPreviewShownTargets(activated.value ? targetIds : [])
    const listed = new Set(targetIds)
    for (const targetId of Object.keys(frames.value))
      if (!listed.has(targetId)) dropFrame(targetId)
    void nextTick(() => {
      observeHost()
      observeStack()
      publishReserve()
    })
  },
)
watch([compact, expanded], () => void nextTick(publishReserve))
watch(
  previewFocusRequest(),
  (request) => {
    if (!request || !activated.value) return
    if (!targets.value.some((target) => target.targetId === request.targetId))
      return
    consumePreviewFocus(request)
    bringForward(request.targetId)
    if (compact.value) expanded.value = true
    enlarge(request.targetId)
  },
  { immediate: true },
)

onMounted(() => {
  stopFrames = onAgentPreviewFrame(onFrame)
  stopPointers = onAgentPreviewPointer(onPointer)
  unsubscribeCore = onCoreEvent((event) => {
    if (
      event &&
      typeof event === 'object' &&
      (event as { event?: unknown }).event === 'computer_use_changed'
    )
      scheduleRefresh()
  })
  document.addEventListener('keydown', onDocumentKeydown)
  document.addEventListener('visibilitychange', onVisibility)
  void refresh()
})

onActivated(() => {
  activated.value = true
  setPreviewShownTargets(ordered.value.map((target) => target.targetId))
  void refresh()
  void nextTick(publishReserve)
})

onDeactivated(() => {
  activated.value = false
  expanded.value = false
  stopAllLive()
  forgetPointers()
  setPreviewShownTargets([])
  publishReserve()
})

onBeforeUnmount(() => {
  alive = false
  unsubscribeCore()
  stopFrames()
  stopPointers()
  stopAllLive()
  forgetPointers()
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('visibilitychange', onVisibility)
  hostObserver?.disconnect()
  stackObserver?.disconnect()
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  setPreviewShownTargets([])
  previewLayout.reservedHeight = 0
})
</script>

<template>
  <section
    v-if="front"
    ref="root"
    class="cu-preview"
    :data-compact="compact || undefined"
    :data-expanded="expanded || undefined"
    aria-label="电脑操作预览"
  >
    <button
      v-if="compact"
      type="button"
      class="cu-preview-chip"
      :aria-expanded="expanded"
      aria-controls="cu-preview-stack"
      @click="expanded = !expanded"
    >
      <ScreenShare :size="16" aria-hidden="true" />
      <span>电脑操作</span>
      <Badge variant="count" :label="ordered.length" />
    </button>
    <div
      v-show="!compact || expanded"
      id="cu-preview-stack"
      ref="stack"
      class="cu-preview-stack"
      @keydown="onStackKeydown"
    >
      <button
        v-for="(target, index) in behind"
        :key="target.targetId"
        type="button"
        class="cu-strip"
        :style="{ '--depth': behind.length - index }"
        :aria-label="`切换到 ${previewTitle(target)}`"
        @click="bringForward(target.targetId)"
      >
        <component :is="iconOf(target)" :size="12" aria-hidden="true" />
        <span class="cu-strip-title">{{ previewTitle(target) }}</span>
        <span class="cu-strip-status" :data-tone="statusOf(target).tone">{{
          statusOf(target).label
        }}</span>
      </button>
      <article class="cu-card" :data-target="front.targetId">
        <header class="cu-card-head">
          <component :is="iconOf(front)" :size="14" aria-hidden="true" />
          <span class="cu-card-title" :title="previewTitle(front)">{{
            previewTitle(front)
          }}</span>
          <span class="cu-card-status" :data-tone="statusOf(front).tone">{{
            statusOf(front).label
          }}</span>
          <Badge
            v-if="ordered.length > 1"
            class="cu-card-total"
            variant="count"
            :label="ordered.length"
            :aria-label="`共 ${ordered.length} 个目标`"
          />
        </header>
        <p class="cu-card-source" :title="front.url">
          {{ previewSource(front) }}
        </p>
        <button
          v-if="frameSrc(frameOf(front))"
          type="button"
          class="cu-card-frame"
          :aria-label="`放大查看 ${previewTitle(front)}`"
          @click="enlarge(front.targetId)"
        >
          <img
            :src="frameSrc(frameOf(front))"
            :alt="`${previewTitle(front)}的${frameOf(front).kind === 'shot' ? '最近截图' : '画面'}`"
          />
          <span
            v-if="frontPointer"
            :key="front.targetId"
            class="cu-pointer"
            :data-glide="reducedMotion ? undefined : ''"
            :data-fading="frontPointer.fading || undefined"
            :style="{
              transform: `translate(${frontPointer.left}%, ${frontPointer.top}%)`,
            }"
            aria-hidden="true"
          >
            <svg
              class="cu-pointer-arrow"
              width="20"
              height="20"
              viewBox="0 0 32 32"
              focusable="false"
            >
              <path
                d="M1 1 L1 23 L7 17.5 L11 26.5 L15 24.8 L11 16 L18.5 16 Z"
              />
            </svg>
          </span>
        </button>
        <p v-else class="cu-card-empty" :data-kind="frameOf(front).kind">
          {{ frameOf(front).note }}
        </p>
        <p
          v-if="frameSrc(frameOf(front))"
          class="cu-card-note"
          :data-kind="frameOf(front).kind"
        >
          {{ frameOf(front).note }}
        </p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.cu-preview {
  position: absolute;
  right: var(--space-4);
  bottom: calc(var(--space-8) + var(--space-3));
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  width: min(var(--env-card-width, 340px), 100% - 2 * var(--space-4));
  pointer-events: none;
}

.cu-preview > * {
  pointer-events: auto;
}

.cu-preview-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--surface-base));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--text-1));
  font: var(--font-xs);
  cursor: pointer;
}

.cu-preview-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* Cards behind the front one: staggered strips, narrower the deeper. */
.cu-strip {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  align-self: center;
  width: calc(100% - var(--depth) * 2 * var(--space-3));
  margin-bottom: calc(0px - var(--space-1));
  padding: var(--space-1) var(--space-3) var(--space-2);
  border: 1px solid var(--stroke-2);
  border-bottom: 0;
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-2));
  font: var(--font-xxs);
  text-align: start;
  cursor: pointer;
}

.cu-strip:hover {
  background: rgb(var(--surface-overlay));
}

.cu-strip-title,
.cu-card-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cu-strip-status,
.cu-card-status {
  flex: none;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.cu-strip-status[data-tone='active'],
.cu-card-status[data-tone='active'] {
  color: rgb(var(--accent));
}

.cu-strip-status[data-tone='waiting'],
.cu-card-status[data-tone='waiting'] {
  color: rgb(var(--warn));
}

.cu-strip-status[data-tone='lost'],
.cu-card-status[data-tone='lost'] {
  color: rgb(var(--error));
}

.cu-card {
  position: relative;
  min-width: 0;
  padding: var(--space-2-5) var(--space-3) var(--space-3);
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-base));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--text-1));
}

.cu-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xs);
  font-weight: var(--weight-semibold);
}

.cu-card-source {
  margin: var(--space-0-5) 0 var(--space-2);
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cu-card-frame {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-row);
  background: rgb(var(--surface-canvas));
  cursor: zoom-in;
}

.cu-card-frame img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10; /* FRAME_ASPECT */
  object-fit: contain;
}

/* The Agent's pointer: the on-screen arrow, its tip where the latest action
   landed. The layer covers the picture and moves by a share of its own
   size, so only transform and opacity animate. */
.cu-pointer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: cu-pointer-in var(--duration-fast) var(--ease-out);
  transition: opacity var(--duration-slow) var(--ease-out);
}

.cu-pointer[data-glide] {
  transition:
    transform var(--duration) var(--ease-out),
    opacity var(--duration-slow) var(--ease-out);
}

.cu-pointer[data-fading] {
  opacity: 0;
}

.cu-pointer-arrow {
  display: block;
  overflow: visible;
  filter: drop-shadow(0 1px 2px rgb(var(--pointer-ink) / 0.45));
}

.cu-pointer-arrow path {
  fill: rgb(var(--pointer-ink) / 0.55);
  stroke: rgb(var(--accent));
  stroke-width: 1.6;
  stroke-linejoin: round;
}

@keyframes cu-pointer-in {
  from {
    opacity: 0;
  }
}

.cu-card-empty {
  display: grid;
  margin: 0;
  aspect-ratio: 16 / 10;
  place-items: center;
  border: 1px dashed var(--stroke-2);
  border-radius: var(--radius-row);
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  text-align: center;
}

.cu-card-note {
  margin: var(--space-1-5) 0 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.cu-card-note[data-kind='live'] {
  color: rgb(var(--accent));
}

.cu-card-note[data-kind='frozen'] {
  color: rgb(var(--warn));
}

.cu-strip:focus-visible,
.cu-card-frame:focus-visible,
.cu-preview-chip:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.cu-enlarged {
  display: block;
  width: 100%;
  max-height: 70vh;
  object-fit: contain;
  border-radius: var(--radius-row);
  background: rgb(var(--surface-canvas));
}

.cu-enlarged-note {
  margin: var(--space-2) 0 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}
</style>
