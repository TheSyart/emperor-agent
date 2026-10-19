<script setup lang="ts">
/**
 * The window shell (UI-S01; dsh ui-layout AppFrame): the permanent 56px icon
 * rail, the sidebar on the canvas, then the conversation (or full page) and
 * the workspace, each on its own `--surface-base` panel (radius 12) inside
 * an 8px canvas gutter. No column draws a border. Grid tracks are solved by
 * columns.ts from the frame's own width. Narrow frames (< 1024px) fold the
 * sidebar (the rail stays); the folded sidebar and the closed workspace stay
 * mounted at width 0, inert. With the sidebar folded the center panel starts
 * after the traffic lights (`--shell-lights-clear`) instead of 8px after the
 * rail. Drag handles sit on the gutters and use pointer capture + rAF
 * throttling against the width captured at drag start; widths never animate.
 *
 * Props:
 * - workspaceAvailable? (default true) — false forces the column closed.
 * - centerMin? (default CENTER_MIN_CHAT) — center floor the workspace
 *   concedes to (the Trajectory tab passes CENTER_MIN_TRAJECTORY).
 *
 * Slots:
 * - rail ({ collapsed, toggle }) — the icon rail column.
 * - sidebar ({ collapsed, width, toggle }) — left column (kept mounted).
 * - default — center panel (conversation / page).
 * - workspace ({ open }) — right panel; kept mounted while closed.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CENTER_MIN_CHAT,
  computeColumns,
  SHELL_GUTTER,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
} from './columns'
import { frameActions, useFrameState } from './frameState'

type Side = 'sidebar' | 'workspace'

const props = withDefaults(
  defineProps<{ workspaceAvailable?: boolean; centerMin?: number }>(),
  { workspaceAvailable: true, centerMin: CENTER_MIN_CHAT },
)

const frame = useFrameState()
const root = ref<HTMLElement | null>(null)
const viewport = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
const dragging = ref<Side | null>(null)

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
    props.workspaceAvailable ? frame.workspace : 0,
    props.centerMin,
  )
})
const gridStyle = computed(() => ({
  gridTemplateColumns: `${columns.value.rail}px ${columns.value.sidebar}px minmax(0, 1fr) ${columns.value.workspace}px`,
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
  else if (dragging.value === 'workspace')
    frameActions.setWorkspace(frame, base - dx)
}

function onPointerDown(side: Side, event: PointerEvent) {
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  origin = event.clientX
  latest = event.clientX
  base = side === 'sidebar' ? columns.value.sidebar : columns.value.workspace
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

function onHandleKeydown(side: Side, event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 16
  const sign = side === 'sidebar' ? 1 : -1
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (side === 'sidebar')
      frameActions.setSidebar(frame, columns.value.sidebar - step * sign)
    else frameActions.setWorkspace(frame, columns.value.workspace - step * sign)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (side === 'sidebar')
      frameActions.setSidebar(frame, columns.value.sidebar + step * sign)
    else frameActions.setWorkspace(frame, columns.value.workspace + step * sign)
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
    :data-workspace-collapsed="columns.workspace === 0 || undefined"
    :data-dragging="dragging || undefined"
    :data-narrow="narrow || undefined"
  >
    <div class="rail-col">
      <slot name="rail" :collapsed="sidebarCollapsed" :toggle="toggleSidebar" />
    </div>
    <div
      class="sidebar-col"
      :aria-hidden="sidebarCollapsed || undefined"
      :inert="sidebarCollapsed || undefined"
    >
      <slot
        name="sidebar"
        :collapsed="sidebarCollapsed"
        :width="columns.sidebar"
        :toggle="toggleSidebar"
      />
    </div>
    <main class="center-col">
      <div class="shell-panel" data-panel="center">
        <slot />
      </div>
    </main>
    <div
      class="workspace-col"
      :aria-hidden="columns.workspace === 0 || undefined"
      :inert="columns.workspace === 0 || undefined"
    >
      <div class="shell-panel" data-panel="workspace">
        <slot name="workspace" :open="columns.workspace > 0" />
      </div>
    </div>
    <div
      v-if="!sidebarCollapsed"
      class="handle"
      data-side="sidebar"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      tabindex="0"
      :style="{ left: `${columns.rail + columns.sidebar}px` }"
      :data-dragging="dragging === 'sidebar' || undefined"
      @pointerdown="onPointerDown('sidebar', $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onHandleKeydown('sidebar', $event)"
    />
    <div
      v-if="columns.workspace > 0"
      class="handle"
      data-side="workspace"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整工作台宽度"
      tabindex="0"
      :style="{ left: `${viewport - columns.workspace - SHELL_GUTTER}px` }"
      :data-dragging="dragging === 'workspace' || undefined"
      @pointerdown="onPointerDown('workspace', $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onHandleKeydown('workspace', $event)"
    />
    <slot name="overlay" />
  </div>
</template>

<style scoped>
/* Canvas → panels: the rail and the sidebar sit on the canvas; the center
   and workspace columns hold a panel inside the gutter (the gutter between
   the two panels belongs to the center column). Widths never animate. */
.app-frame {
  position: relative;
  display: grid;
  grid-template-rows: 100%;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: rgb(var(--surface-canvas));
}

.app-frame[data-dragging] {
  cursor: col-resize;
  user-select: none;
}

.rail-col,
.sidebar-col,
.center-col,
.workspace-col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.sidebar-col {
  padding-top: var(--shell-gutter);
}

.center-col {
  display: flex;
  flex-direction: column;
  padding: var(--shell-gutter);
}

/* Folded sidebar: the panel starts after the traffic lights. */
.app-frame[data-sidebar-collapsed] .center-col {
  padding-left: calc(var(--shell-lights-clear) - var(--rail-w));
}

.workspace-col {
  padding: var(--shell-gutter) var(--shell-gutter) var(--shell-gutter) 0;
}

.app-frame[data-workspace-collapsed] .workspace-col {
  padding: 0;
}

.shell-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--panel-radius);
  background: rgb(var(--surface-base));
  box-shadow: var(--panel-edge);
}

.handle {
  position: absolute;
  top: var(--shell-gutter);
  bottom: 0;
  z-index: var(--z-raised);
  width: var(--shell-gutter);
  cursor: col-resize;
  outline: none;
  touch-action: none;
  -webkit-app-region: no-drag;
}

.handle[data-side='workspace']::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--space-1);
  height: var(--space-8);
  border-radius: var(--r-full);
  background: rgb(var(--stroke-solid-strong));
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity var(--duration-ds-slow) var(--ease-in-out);
}

.workspace-col:hover ~ .handle[data-side='workspace']::after,
.handle[data-side='workspace']:hover::after,
.handle[data-side='workspace']:focus-visible::after,
.handle[data-side='workspace'][data-dragging]::after {
  opacity: 1;
}

.handle[data-side='sidebar']:focus-visible {
  background: rgb(var(--focus-ring) / 0.3);
}
</style>
