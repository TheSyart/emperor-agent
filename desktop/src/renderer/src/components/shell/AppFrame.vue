<script setup lang="ts">
/**
 * Three-column shell frame (dsh ui-layout AppFrame): sidebar | center |
 * details grid tracks solved by columns.ts from the frame's own width. Narrow
 * frames (< 1024px) auto-collapse the sidebar to the 56px rail; the details
 * column stays mounted at width 0 when closed. Drag handles use pointer
 * capture + rAF throttling against the width captured at drag start.
 *
 * Slots:
 * - sidebar ({ collapsed, width, toggle }) — left column.
 * - default — center column (conversation).
 * - details ({ open }) — right column; kept mounted while closed.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  computeColumns,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
} from './columns'
import { frameActions, useFrameState } from './frameState'

const props = withDefaults(defineProps<{ detailsAvailable?: boolean }>(), {
  detailsAvailable: true,
})

const frame = useFrameState()
const root = ref<HTMLElement | null>(null)
const viewport = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
const dragging = ref<'sidebar' | 'details' | null>(null)

const narrow = computed(() => viewport.value < SIDEBAR_AUTO_COLLAPSE)
watch(narrow, (value) => frameActions.setNarrow(frame, value), {
  immediate: true,
})

const sidebarCollapsed = computed(() => frameActions.sidebarCollapsed(frame))
const columns = computed(() => {
  const sidebarPreference = sidebarCollapsed.value
    ? 0
    : frame.sidebar === 0
      ? SIDEBAR_DEFAULT
      : frame.sidebar
  return computeColumns(
    viewport.value,
    sidebarPreference,
    props.detailsAvailable ? frame.details : 0,
  )
})
const gridStyle = computed(() => ({
  gridTemplateColumns: `${columns.value.sidebar}px minmax(0, 1fr) ${columns.value.details}px`,
}))

function toggleSidebar(): void {
  frameActions.toggleSidebar(frame)
}

let observer: ResizeObserver | null = null
let resizeFrame: number | null = null

function measure(): void {
  const width = root.value?.getBoundingClientRect().width ?? 0
  if (width > 0) viewport.value = width
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined' || !root.value) return
  observer = new ResizeObserver(() => {
    resizeFrame ??= requestAnimationFrame(() => {
      resizeFrame = null
      measure()
    })
  })
  observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
})

// ── drag handles ────────────────────────────────────────────────────────
let origin = 0
let latest = 0
let base = 0
let dragFrame: number | null = null

function applyDrag(): void {
  const dx = latest - origin
  if (dragging.value === 'sidebar') frameActions.setSidebar(frame, base + dx)
  else if (dragging.value === 'details')
    frameActions.setDetails(frame, base - dx)
}

function onPointerDown(side: 'sidebar' | 'details', event: PointerEvent) {
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  origin = event.clientX
  latest = event.clientX
  base = side === 'sidebar' ? columns.value.sidebar : columns.value.details
  dragging.value = side
}

function onPointerMove(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  if (!dragging.value || !target.hasPointerCapture(event.pointerId)) return
  latest = event.clientX
  dragFrame ??= requestAnimationFrame(() => {
    dragFrame = null
    applyDrag()
  })
}

function onPointerUp(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  if (!target.hasPointerCapture(event.pointerId)) return
  target.releasePointerCapture(event.pointerId)
  if (dragFrame !== null) {
    cancelAnimationFrame(dragFrame)
    dragFrame = null
  }
  applyDrag()
  dragging.value = null
}

function onHandleKeydown(side: 'sidebar' | 'details', event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 16
  const sign = side === 'sidebar' ? 1 : -1
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (side === 'sidebar')
      frameActions.setSidebar(frame, columns.value.sidebar - step * sign)
    else frameActions.setDetails(frame, columns.value.details - step * sign)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (side === 'sidebar')
      frameActions.setSidebar(frame, columns.value.sidebar + step * sign)
    else frameActions.setDetails(frame, columns.value.details + step * sign)
  }
}

defineExpose({ toggleSidebar, columns })
</script>

<template>
  <div
    ref="root"
    class="app-frame"
    :style="gridStyle"
    :data-sidebar-collapsed="sidebarCollapsed || undefined"
    :data-details-collapsed="columns.details === 0 || undefined"
    :data-dragging="dragging || undefined"
    :data-narrow="narrow || undefined"
  >
    <div class="sidebar-col">
      <slot
        name="sidebar"
        :collapsed="sidebarCollapsed"
        :width="columns.sidebar"
        :toggle="toggleSidebar"
      />
    </div>
    <main class="center-col">
      <slot />
    </main>
    <div class="details-col" :aria-hidden="columns.details === 0 || undefined">
      <slot name="details" :open="columns.details > 0" />
    </div>
    <div
      v-if="!sidebarCollapsed"
      class="handle"
      data-side="sidebar"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      tabindex="0"
      :style="{ left: `${columns.sidebar}px` }"
      :data-dragging="dragging === 'sidebar' || undefined"
      @pointerdown="onPointerDown('sidebar', $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onHandleKeydown('sidebar', $event)"
    />
    <div
      v-if="columns.details > 0"
      class="handle"
      data-side="details"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情栏宽度"
      tabindex="0"
      :style="{ left: `${viewport - columns.details}px` }"
      :data-dragging="dragging === 'details' || undefined"
      @pointerdown="onPointerDown('details', $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onHandleKeydown('details', $event)"
    />
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.app-frame {
  position: relative;
  display: grid;
  grid-template-rows: 100%;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: rgb(var(--bg-base));
  transition: grid-template-columns var(--duration-ds-slow) var(--ease-in-out);
}

.app-frame[data-dragging] {
  transition: none;
  cursor: col-resize;
  user-select: none;
}

.sidebar-col {
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid var(--border-l1);
  background: rgb(var(--sidebar-fill));
}

.center-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.details-col {
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--border-l2);
}

.app-frame[data-details-collapsed] .details-col {
  border-left: none;
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: var(--z-raised);
  width: var(--space-2);
  margin-left: calc(0px - var(--space-1));
  cursor: col-resize;
  outline: none;
  touch-action: none;
}

.handle[data-side='details']::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  width: var(--space-3);
  height: var(--space-8);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-layer-2));
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity var(--duration-ds-slow) var(--ease-in-out);
}

.details-col:hover ~ .handle[data-side='details']::after,
.handle[data-side='details']:hover::after,
.handle[data-side='details']:focus-visible::after,
.handle[data-side='details'][data-dragging]::after {
  opacity: 1;
}

.handle[data-side='sidebar']:focus-visible {
  background: rgb(var(--focus-ring) / 0.3);
}
</style>
