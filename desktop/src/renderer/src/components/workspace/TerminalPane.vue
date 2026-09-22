<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent, TerminalSummary } from '@emperor/core/api'
import { Plus, TerminalSquare, X } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onTerminalEvent } from '../../api/backend'
import { core } from '../../api/http'

const props = defineProps<{ sessionId: string }>()
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

onMounted(async () => {
  await restore()
})
watch(
  () => props.sessionId,
  () => void restore(),
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

async function createTerminal(
  owner = props.sessionId,
  generation = ownerGeneration,
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
    await activate(created.id, owner, generation)
  } catch (cause) {
    if (isCurrentOwner(owner, generation)) error.value = message(cause)
  }
}

async function activate(
  terminalId: string,
  owner = props.sessionId,
  generation = ownerGeneration,
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
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: 12,
    scrollback: 10_000,
    theme: {
      background: cssColor(style, '--bg', 'rgb(12 12 14)'),
      foreground: cssColor(style, '--fg', 'rgb(238 238 241)'),
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
  resizeObserver = new ResizeObserver(() => fitAndResize())
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
      terminal.writeln(
        `\r\n[process exited: ${replay.terminal.exitCode ?? 'signal'}]`,
      )
    terminal.focus()
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
    terminal?.writeln(`\r\n[process exited: ${event.exitCode ?? 'signal'}]`)
  }
}

function fitAndResize(): void {
  if (!terminal || !fitAddon || !activeId.value) return
  const owner = props.sessionId
  const terminalId = activeId.value
  const activation = activationGeneration
  try {
    fitAddon.fit()
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
      )
        error.value = message(cause)
    })
  } catch {
    // Hidden panels can briefly report zero bounds; the next observer tick retries.
  }
}

function disposeTerminal(): void {
  activationGeneration += 1
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

function selectAdjacentTerminal(index: number, key: string): void {
  if (!terminals.value.length) return
  let target = index
  if (key === 'ArrowLeft')
    target = (index - 1 + terminals.value.length) % terminals.value.length
  else if (key === 'ArrowRight') target = (index + 1) % terminals.value.length
  else if (key === 'Home') target = 0
  else if (key === 'End') target = terminals.value.length - 1
  else return
  const item = terminals.value[target]
  if (!item) return
  void activate(item.id).then(() => {
    document.getElementById(`terminal-tab-${item.id}`)?.focus()
  })
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
    <div class="terminal-tabs" role="tablist" aria-label="项目终端">
      <div
        v-for="(item, index) in terminals"
        :key="item.id"
        class="terminal-tab-item"
        :class="{ active: activeId === item.id, exited: item.exited }"
      >
        <button
          :id="`terminal-tab-${item.id}`"
          type="button"
          role="tab"
          class="terminal-tab-button"
          :aria-selected="activeId === item.id"
          :aria-controls="`terminal-panel-${item.id}`"
          :tabindex="activeId === item.id ? 0 : -1"
          :class="{ active: activeId === item.id }"
          @click="activate(item.id)"
          @keydown="selectAdjacentTerminal(index, $event.key)"
        >
          <TerminalSquare :size="13" />
          <span>{{ item.title || `Terminal ${index + 1}` }}</span>
          <span v-if="item.exited" class="sr-only">已退出</span>
        </button>
        <button
          type="button"
          class="terminal-tab-close"
          :aria-label="`关闭 ${item.title || `Terminal ${index + 1}`}`"
          @click="closeTerminal(item.id)"
        >
          <X :size="12" />
        </button>
      </div>
      <button
        type="button"
        class="terminal-new-tab"
        :disabled="terminals.length >= 8"
        aria-label="新建终端"
        @click="createTerminal()"
      >
        <Plus :size="14" />
      </button>
    </div>
    <div v-if="error" class="terminal-error" role="alert">{{ error }}</div>
    <button
      v-if="!terminals.length"
      type="button"
      class="terminal-empty-action"
      @click="createTerminal()"
    >
      <TerminalSquare :size="16" />
      新建终端
    </button>
    <div
      ref="container"
      class="terminal-surface"
      role="tabpanel"
      :id="activeId ? `terminal-panel-${activeId}` : undefined"
      :aria-labelledby="activeId ? `terminal-tab-${activeId}` : undefined"
      aria-label="交互式系统终端"
    ></div>
  </div>
</template>

<style scoped>
.terminal-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: rgb(var(--bg-base));
}

.terminal-tabs {
  display: flex;
  min-height: calc(var(--space-8) + var(--space-2));
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: 0 var(--space-2);
  overflow-x: auto;
  border-bottom: 1px solid var(--border-l1);
  scrollbar-width: none;
}

.terminal-tabs::-webkit-scrollbar {
  display: none;
}

.terminal-tab-item {
  display: inline-flex;
  max-width: 140px;
  flex: none;
  align-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-tertiary));
}

.terminal-tab-item:hover {
  color: rgb(var(--label-secondary));
  background: var(--interactive-bg-hover);
}

.terminal-tab-item.active {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-active);
}

.terminal-tab-item.exited {
  opacity: 0.6;
}

.terminal-tab-button {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2);
  color: inherit;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.terminal-tab-button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-tab-close {
  display: inline-grid;
  place-items: center;
  margin-right: var(--space-1);
  padding: 2px;
  border-radius: var(--radius-xs);
  color: inherit;
}

.terminal-tab-close:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.terminal-new-tab {
  display: inline-grid;
  width: var(--space-7);
  height: var(--space-7);
  flex: none;
  place-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.terminal-new-tab:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.terminal-new-tab:disabled {
  opacity: 0.4;
}

.terminal-error {
  flex: none;
  margin: var(--space-2) var(--space-3) 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.terminal-empty-action {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-6);
  padding: var(--space-1-5) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.terminal-empty-action:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.terminal-surface {
  min-height: 0;
  flex: 1;
  padding: var(--space-2) var(--space-1) var(--space-1) var(--space-2);
  overflow: hidden;
  background: rgb(var(--bg-base));
}

.terminal-surface :deep(.xterm) {
  height: 100%;
}
</style>
