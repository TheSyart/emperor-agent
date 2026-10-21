<script setup lang="ts">
/**
 * TerminalPane — the right workspace's 终端 pane: tabs of the session's PTYs
 * (WorkspaceTabBar, the strip 文件 uses too; 「+」 opens another) over one
 * xterm surface (the active tab, replayed from Core on activation). With no
 * terminal the surface says so; 「+」 is the only way to start one.
 *
 * Sizing (FIX-05): fits wait until the surface size has settled for 100 ms,
 * are skipped while the column is closed (`visible` false) or the surface is
 * below 20 × 5 cells, and the PTY hears only about a size it has not been
 * sent yet (terminalFit.ts). Focus: only an explicit activation — the pane
 * picked (`focusRequest`), a tab clicked, 新建终端 — moves keyboard focus
 * into the terminal; restoring after a session switch, or arrowing along the
 * tabs, never does.
 *
 * Props:
 * - sessionId.
 * - visible?: the workspace column is open (default true).
 * - focusRequest?: nonce; a new non-zero value focuses the terminal once it
 *   is ready (WorkspacePanel sends one when the user shows this pane).
 */
import { confirmTerminalClose } from './terminalClose'
import { terminalExitLine } from './terminalExit'
import EmptyState from '../ui/EmptyState.vue'
import IconButton from '../ui/IconButton.vue'
import type { TabItem } from '../ui/blockTypes'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent, TerminalSummary } from '@emperor/core/api'
import { Plus, SquareTerminal } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WorkspaceTabBar from './WorkspaceTabBar.vue'
import { onTerminalEvent } from '../../api/backend'
import { core } from '../../api/http'
import {
  TERMINAL_RESIZE_DEBOUNCE_MS,
  fitAllowed,
  terminalFontFamily,
} from './terminalFit'

const props = withDefaults(
  defineProps<{
    sessionId: string
    visible?: boolean
    focusRequest?: number
  }>(),
  { visible: true, focusRequest: 0 },
)
const container = ref<HTMLElement | null>(null)
const terminals = ref<TerminalSummary[]>([])
const activeId = ref('')
const error = ref('')
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let latestSeq = 0
let unsubscribe: () => void = () => undefined
let ownerGeneration = 0
let activationGeneration = 0
let initializing = false
let pendingEvents: TerminalEvent[] = []
let pendingEventBytes = 0
let pendingOverflow = false
let resizeTimer: ReturnType<typeof setTimeout> | undefined
/** `cols×rows` last sent to the active PTY ('' = nothing yet). */
let sentSize = ''
/** The user asked for the terminal; focus it once it is ready. */
let focusPending = false
/** A tab is being picked with the keyboard (focus stays on the strip). */
let pickingByKey = false

const tabItems = computed<TabItem[]>(() =>
  terminals.value.map((item, index) => {
    const label = item.title || `终端 ${index + 1}`
    return {
      id: item.id,
      label: item.exited ? `${label} · 已退出` : label,
      icon: SquareTerminal,
      closable: true,
    }
  }),
)

onMounted(async () => {
  await restore()
})
watch(
  () => props.sessionId,
  () => {
    // Restoring another session's terminals is not an activation.
    focusPending = false
    void restore()
  },
)
watch(
  () => props.focusRequest,
  (nonce) => {
    focusPending = Boolean(nonce)
    if (focusPending && terminal && !initializing) {
      focusPending = false
      terminal.focus()
    }
  },
  { immediate: true },
)
// The column opened again: fit once its animation has settled.
watch(
  () => props.visible,
  (visible) => visible && scheduleFit(),
)
onBeforeUnmount(() => {
  ownerGeneration += 1
  disposeTerminal()
  unsubscribe()
  unsubscribe = () => undefined
})

async function restore(): Promise<void> {
  const owner = props.sessionId
  const generation = ++ownerGeneration
  disposeTerminal()
  unsubscribe()
  unsubscribe = () => undefined
  error.value = ''
  activeId.value = ''
  latestSeq = 0
  try {
    const listed = await core('terminals.list', {
      sessionId: owner,
    })
    if (!isCurrentOwner(owner, generation)) return
    terminals.value = listed
    if (!listed.length) await createTerminal(owner, generation)
    else await activate(listed[0]!.id, owner, generation)
  } catch (cause) {
    if (isCurrentOwner(owner, generation)) error.value = message(cause)
  }
}

/** 新建终端: an explicit activation, so the new terminal takes focus. */
function newTerminal(): void {
  void createTerminal(props.sessionId, ownerGeneration, true)
}

function setKeyPick(picking: boolean): void {
  pickingByKey = picking
}

/** A tab picked: clicked is an explicit activation, arrowed to is not. */
function selectTerminal(terminalId: string): void {
  if (terminalId === activeId.value) return
  void activate(terminalId, props.sessionId, ownerGeneration, !pickingByKey)
}

async function createTerminal(
  owner = props.sessionId,
  generation = ownerGeneration,
  focus = false,
): Promise<void> {
  if (terminals.value.length >= 8) return
  try {
    const created = await core('terminals.create', {
      sessionId: owner,
      cols: 100,
      rows: 30,
    })
    if (!isCurrentOwner(owner, generation)) {
      void core('terminals.close', {
        sessionId: owner,
        terminalId: created.id,
      }).catch(() => undefined)
      return
    }
    terminals.value = [...terminals.value, created]
    await activate(created.id, owner, generation, focus)
  } catch (cause) {
    if (isCurrentOwner(owner, generation)) error.value = message(cause)
  }
}

async function activate(
  terminalId: string,
  owner = props.sessionId,
  generation = ownerGeneration,
  focus = false,
): Promise<void> {
  if (!terminalId || !isCurrentOwner(owner, generation)) return
  disposeTerminal()
  const activation = activationGeneration
  activeId.value = terminalId
  unsubscribe()
  unsubscribe = onTerminalEvent(handleTerminalEvent, {
    sessionId: owner,
    terminalId,
  })
  latestSeq = 0
  initializing = true
  pendingEvents = []
  pendingEventBytes = 0
  pendingOverflow = false
  await nextTick()
  if (
    !container.value ||
    !isCurrentActivation(owner, generation, activation, terminalId)
  ) {
    if (isCurrentActivation(owner, generation, activation, terminalId))
      initializing = false
    return
  }
  const style = getComputedStyle(document.documentElement)
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    // Canvas measuring cannot resolve var(): pass the computed family.
    fontFamily: terminalFontFamily(container.value),
    fontSize: 12,
    scrollback: 10_000,
    theme: {
      // The workspace panel's surface (UI-S01).
      background: cssColor(style, '--surface-base', 'rgb(26 26 25)'),
      foreground: cssColor(style, '--text-1', 'rgb(238 238 241)'),
      cursor: cssColor(style, '--accent', 'rgb(99 153 255)'),
      selectionBackground: 'rgba(103, 167, 255, 0.28)',
    },
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(container.value)
  terminal.onData((data) => {
    void core('terminals.write', {
      sessionId: owner,
      terminalId,
      data,
    }).catch((cause) => {
      if (isCurrentActivation(owner, generation, activation, terminalId))
        error.value = message(cause)
    })
  })
  resizeObserver = new ResizeObserver(() => scheduleFit())
  resizeObserver.observe(container.value)
  fitAndResize()
  try {
    const replay = await core('terminals.read', {
      sessionId: owner,
      terminalId,
      afterSeq: 0,
    })
    if (
      !isCurrentActivation(owner, generation, activation, terminalId) ||
      !terminal
    )
      return
    for (const chunk of replay.chunks) terminal.write(chunk.data)
    terminals.value = terminals.value.map((item) =>
      item.id === terminalId ? replay.terminal : item,
    )
    latestSeq = replay.latestSeq
    if (pendingOverflow) {
      const catchup = await core('terminals.read', {
        sessionId: owner,
        terminalId,
        afterSeq: latestSeq,
      })
      if (!isCurrentActivation(owner, generation, activation, terminalId))
        return
      for (const chunk of catchup.chunks) terminal?.write(chunk.data)
      terminals.value = terminals.value.map((item) =>
        item.id === terminalId ? catchup.terminal : item,
      )
      latestSeq = catchup.latestSeq
    }
    const buffered = pendingEvents.sort((left, right) => left.seq - right.seq)
    pendingEvents = []
    pendingEventBytes = 0
    pendingOverflow = false
    initializing = false
    for (const event of buffered) applyTerminalEvent(event)
    if (replay.terminal.exited)
      terminal.writeln(terminalExitLine(replay.terminal.exitCode))
    if (focus || focusPending) {
      focusPending = false
      terminal.focus()
    }
  } catch (cause) {
    if (isCurrentActivation(owner, generation, activation, terminalId))
      error.value = message(cause)
  } finally {
    if (isCurrentActivation(owner, generation, activation, terminalId))
      initializing = false
  }
}

async function closeTerminal(terminalId: string): Promise<void> {
  const owner = props.sessionId
  const generation = ownerGeneration
  if (
    !(await confirmTerminalClose(terminalId, () =>
      core('terminals.list', { sessionId: owner }),
    ))
  )
    return
  try {
    await core('terminals.close', { sessionId: owner, terminalId })
    if (!isCurrentOwner(owner, generation)) return
    terminals.value = terminals.value.filter((item) => item.id !== terminalId)
    if (activeId.value === terminalId) {
      if (terminals.value[0])
        await activate(terminals.value[0].id, owner, generation)
      else {
        disposeTerminal()
        activeId.value = ''
      }
    }
  } catch (cause) {
    if (isCurrentOwner(owner, generation)) error.value = message(cause)
  }
}

function handleTerminalEvent(event: TerminalEvent): void {
  if (event.sessionId !== props.sessionId) return
  if (event.type === 'exit')
    terminals.value = terminals.value.map((item) =>
      item.id === event.terminalId
        ? { ...item, exited: true, exitCode: event.exitCode }
        : item,
    )
  if (event.terminalId !== activeId.value) return
  if (initializing) {
    const bytes = event.type === 'output' ? new Blob([event.data]).size : 32
    if (pendingEventBytes + bytes > 2 * 1024 * 1024) {
      pendingEvents = []
      pendingEventBytes = 0
      pendingOverflow = true
    } else {
      pendingEvents.push(event)
      pendingEventBytes += bytes
    }
    return
  }
  applyTerminalEvent(event)
}

function applyTerminalEvent(event: TerminalEvent): void {
  if (event.seq <= latestSeq) return
  latestSeq = event.seq
  if (event.type === 'output') terminal?.write(event.data)
  else {
    terminals.value = terminals.value.map((item) =>
      item.id === event.terminalId
        ? { ...item, exited: true, exitCode: event.exitCode }
        : item,
    )
    terminal?.writeln(terminalExitLine(event.exitCode))
  }
}

/** The surface changed size: fit once it has settled. */
function scheduleFit(): void {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(fitAndResize, TERMINAL_RESIZE_DEBOUNCE_MS)
}

function fitAndResize(): void {
  clearTimeout(resizeTimer)
  resizeTimer = undefined
  if (!terminal || !fitAddon || !activeId.value || !props.visible) return
  const owner = props.sessionId
  const terminalId = activeId.value
  const activation = activationGeneration
  try {
    // A closing column or a squeezed window: keep the size the PTY has.
    if (!fitAllowed(fitAddon.proposeDimensions())) return
    fitAddon.fit()
  } catch {
    // Hidden panels can briefly report zero bounds; the next change retries.
    return
  }
  const size = `${terminal.cols}x${terminal.rows}`
  if (size === sentSize) return
  sentSize = size
  void core('terminals.resize', {
    sessionId: owner,
    terminalId,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch((cause) => {
    if (
      props.sessionId === owner &&
      activeId.value === terminalId &&
      activationGeneration === activation
    ) {
      sentSize = ''
      error.value = message(cause)
    }
  })
}

function disposeTerminal(): void {
  activationGeneration += 1
  clearTimeout(resizeTimer)
  resizeTimer = undefined
  sentSize = ''
  resizeObserver?.disconnect()
  resizeObserver = null
  terminal?.dispose()
  terminal = null
  fitAddon = null
  initializing = false
  pendingEvents = []
  pendingEventBytes = 0
  pendingOverflow = false
}

function isCurrentOwner(owner: string, generation: number): boolean {
  return props.sessionId === owner && ownerGeneration === generation
}

function isCurrentActivation(
  owner: string,
  generation: number,
  activation: number,
  terminalId: string,
): boolean {
  return (
    isCurrentOwner(owner, generation) &&
    activationGeneration === activation &&
    activeId.value === terminalId
  )
}

function cssColor(
  style: CSSStyleDeclaration,
  property: string,
  fallback: string,
): string {
  const value = style.getPropertyValue(property).trim()
  return value ? `rgb(${value})` : fallback
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
</script>

<template>
  <div class="terminal-pane">
    <!-- The strip's keydown runs between these two: arrowing keeps focus. -->
    <div
      class="terminal-tabs"
      @keydown.capture="setKeyPick(true)"
      @keydown="setKeyPick(false)"
    >
      <WorkspaceTabBar
        :model-value="activeId"
        :tabs="tabItems"
        label="项目终端"
        @update:model-value="selectTerminal"
        @close="closeTerminal"
      >
        <template #after>
          <IconButton
            label="新建终端"
            :disabled="terminals.length >= 8"
            @click="newTerminal"
          >
            <Plus :size="16" />
          </IconButton>
        </template>
      </WorkspaceTabBar>
    </div>
    <div v-if="error" class="terminal-error" role="alert">{{ error }}</div>
    <div class="terminal-body">
      <div
        ref="container"
        class="terminal-surface"
        role="tabpanel"
        aria-label="交互式系统终端"
      ></div>
      <EmptyState
        v-if="!terminals.length"
        class="terminal-empty"
        title="没有打开的终端"
        description="用标签栏的 + 新建一个"
        :icon="SquareTerminal"
      />
    </div>
  </div>
</template>

<style scoped>
.terminal-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: rgb(var(--surface-base));
}

.terminal-tabs {
  flex: none;
  min-width: 0;
}

.terminal-error {
  flex: none;
  margin: var(--space-2) var(--space-3) 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--r-sm);
  color: rgb(var(--error));
  background: rgb(var(--error-soft));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.terminal-body {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.terminal-empty {
  position: absolute;
  inset: 0;
  justify-content: center;
}

.terminal-surface {
  min-height: 0;
  flex: 1;
  font-family: var(--font-mono), monospace;
  padding: var(--space-2) var(--space-1) var(--space-1) var(--space-2);
  overflow: hidden;
  background: rgb(var(--surface-base));
}

.terminal-surface :deep(.xterm) {
  height: 100%;
}
</style>
