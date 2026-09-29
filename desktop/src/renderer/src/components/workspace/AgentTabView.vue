<script setup lang="ts">
/**
 * AgentTabView — live preview of one Agent tab in the Browser pane
 * (computer use). Agent tabs render offscreen, so main streams their frames
 * (JPEG) and this view draws them on a canvas. The header shows who is in
 * control and the user's controls (pause / resume, take over / hand back,
 * close).
 *
 * Input reaches the page only while the user has taken the tab over: mouse,
 * wheel and keys (IME text through a hidden textarea) are mapped to page CSS
 * pixels and sent to main, which refuses them in any other control state.
 *
 * Unmounting only stops the frame stream; the Agent's tab keeps running.
 *
 * Props:
 * - tab: the Agent tab (agentTabsModel.AgentTab).
 * - busy: a control request is in flight.
 * Emits:
 * - control(action): the user asked for pause / resume / takeover / handback / close.
 */
import { Hand, Pause, Play, Undo2, X } from 'lucide-vue-next'
import { onBeforeUnmount, ref, watch } from 'vue'
import {
  agentPreviewInput,
  agentPreviewStart,
  agentPreviewStop,
  onAgentPreviewFrame,
  type AgentPreviewFrame,
} from '../../api/backend'
import {
  AGENT_TAB_ACTION_LABELS,
  keyInput,
  previewPoint,
  type AgentTab,
  type AgentTabControlAction,
} from './agentTabsModel'

const props = defineProps<{
  tab: AgentTab
  busy?: boolean
}>()

const emit = defineEmits<{
  control: [action: AgentTabControlAction]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const keyboard = ref<HTMLTextAreaElement | null>(null)
const phase = ref<'connecting' | 'live' | 'error'>('connecting')
const error = ref('')

let viewport = { width: 1280, height: 800 }
let stopFrames = () => {}
let streaming: string | null = null
let decoding = false
let pending: AgentPreviewFrame | null = null
let lastSeq = 0

async function draw(frame: AgentPreviewFrame): Promise<void> {
  const target = canvas.value
  if (!target || typeof createImageBitmap !== 'function') return
  const bitmap = await createImageBitmap(
    new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
  )
  if (target.width !== bitmap.width) target.width = bitmap.width
  if (target.height !== bitmap.height) target.height = bitmap.height
  target.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
}

/** Draw the newest frame only; frames arriving mid-decode replace each other. */
function onFrame(frame: AgentPreviewFrame): void {
  if (frame.targetId !== streaming || frame.seq <= lastSeq) return
  lastSeq = frame.seq
  phase.value = 'live'
  pending = frame
  if (!decoding) void pump()
}

async function pump(): Promise<void> {
  decoding = true
  while (pending) {
    const next = pending
    pending = null
    if (next.targetId !== streaming) continue
    try {
      await draw(next)
    } catch {
      // a broken frame is skipped; the next one repaints everything
    }
  }
  decoding = false
}

async function start(targetId: string): Promise<void> {
  stop()
  streaming = targetId
  lastSeq = 0
  phase.value = 'connecting'
  error.value = ''
  stopFrames = onAgentPreviewFrame(onFrame)
  const result = await agentPreviewStart(targetId)
  if (streaming !== targetId) return
  if (!result.ok) {
    phase.value = 'error'
    error.value = result.error
    return
  }
  viewport = { width: result.width, height: result.height }
}

function stop(): void {
  stopFrames()
  stopFrames = () => {}
  if (streaming) agentPreviewStop(streaming)
  streaming = null
  pending = null
}

watch(
  () => props.tab.targetId,
  (targetId) => void start(targetId),
  { immediate: true },
)

onBeforeUnmount(stop)

// ---------------------------------------------------------------------------
// Input (only while the user has taken the tab over)

function point(event: MouseEvent): { x: number; y: number } | null {
  const target = canvas.value
  if (!target) return null
  return previewPoint(
    target.getBoundingClientRect(),
    viewport,
    event.clientX,
    event.clientY,
  )
}

const BUTTONS = ['left', 'middle', 'right'] as const

function onPointer(event: PointerEvent): void {
  if (!props.tab.interactive) return
  const at = point(event)
  if (!at) return
  if (event.type === 'pointerdown') {
    keyboard.value?.focus()
    canvas.value?.setPointerCapture?.(event.pointerId)
  }
  const type =
    event.type === 'pointerdown'
      ? 'mouseDown'
      : event.type === 'pointerup'
        ? 'mouseUp'
        : 'mouseMove'
  agentPreviewInput(props.tab.targetId, {
    type,
    ...at,
    ...(type === 'mouseMove'
      ? {}
      : {
          button: BUTTONS[event.button] ?? 'left',
          clickCount: Math.max(1, event.detail),
        }),
  })
}

function onWheel(event: WheelEvent): void {
  if (!props.tab.interactive) return
  const at = point(event)
  if (!at) return
  event.preventDefault()
  agentPreviewInput(props.tab.targetId, {
    type: 'wheel',
    ...at,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
  })
}

function onKey(event: KeyboardEvent): void {
  if (!props.tab.interactive || event.isComposing) return
  const input = keyInput(event)
  if (!input) return
  event.preventDefault()
  if (input.kind === 'text') {
    if (event.type === 'keydown')
      agentPreviewInput(props.tab.targetId, { type: 'text', text: input.text })
    return
  }
  agentPreviewInput(props.tab.targetId, {
    type: event.type === 'keydown' ? 'keyDown' : 'keyUp',
    key: input.key,
    modifiers: input.modifiers,
  })
}

function onCompositionEnd(event: CompositionEvent): void {
  if (props.tab.interactive && event.data)
    agentPreviewInput(props.tab.targetId, { type: 'text', text: event.data })
  if (keyboard.value) keyboard.value.value = ''
}

watch(
  () => props.tab.interactive,
  (interactive) => {
    if (interactive) keyboard.value?.focus()
  },
)
</script>

<template>
  <section
    class="agent-tab"
    :data-tone="tab.tone"
    :data-interactive="tab.interactive ? 'true' : undefined"
    :aria-label="`Agent 标签页：${tab.title}`"
  >
    <header class="agent-tab-bar">
      <span class="agent-tab-state" role="status">
        <span class="state-dot" aria-hidden="true"></span>
        {{ tab.label }}
      </span>
      <span class="agent-tab-url" :title="tab.url">{{ tab.url }}</span>
      <div class="agent-tab-actions">
        <button
          v-for="action in tab.actions"
          :key="action"
          type="button"
          class="agent-tab-action"
          :data-action="action"
          :disabled="busy"
          @click="emit('control', action)"
        >
          <Pause v-if="action === 'pause'" :size="13" aria-hidden="true" />
          <Play v-else-if="action === 'resume'" :size="13" aria-hidden="true" />
          <Hand
            v-else-if="action === 'takeover'"
            :size="13"
            aria-hidden="true"
          />
          <Undo2
            v-else-if="action === 'handback'"
            :size="13"
            aria-hidden="true"
          />
          <X v-else :size="13" aria-hidden="true" />
          <span>{{ AGENT_TAB_ACTION_LABELS[action] }}</span>
        </button>
      </div>
    </header>
    <div class="agent-tab-stage">
      <canvas
        ref="canvas"
        class="agent-tab-canvas"
        :data-phase="phase"
        @pointerdown="onPointer"
        @pointerup="onPointer"
        @pointermove="onPointer"
        @wheel="onWheel"
        @contextmenu.prevent
      ></canvas>
      <textarea
        ref="keyboard"
        class="agent-tab-keyboard"
        aria-label="向页面输入"
        :tabindex="tab.interactive ? 0 : -1"
        @keydown="onKey"
        @keyup="onKey"
        @compositionend="onCompositionEnd"
      ></textarea>
      <p v-if="phase === 'connecting'" class="agent-tab-note">正在连接预览…</p>
      <p v-else-if="phase === 'error'" class="agent-tab-note" role="alert">
        无法预览：{{ error }}
      </p>
      <p v-if="!tab.interactive" class="agent-tab-hint">
        {{
          tab.control === 'agent'
            ? 'Agent 正在操作这个标签页。接管后可以直接操作页面。'
            : '接管后可以直接操作页面，交还后 Agent 继续。'
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.agent-tab {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.agent-tab-bar {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-l1);
}

.agent-tab-state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
}

.state-dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--accent-fill));
}

.agent-tab[data-tone='paused'] .state-dot {
  background: rgb(var(--warn));
}

.agent-tab[data-tone='user'] .state-dot {
  background: rgb(var(--ok));
}

.agent-tab[data-tone='stopped'] .state-dot {
  background: rgb(var(--danger));
}

.agent-tab-url {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-tab-actions {
  display: flex;
  flex: none;
  gap: var(--space-1);
}

.agent-tab-action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  transition: background-color var(--duration-ds-fast) ease;
}

.agent-tab-action:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.agent-tab-action:disabled {
  opacity: 0.5;
}

.agent-tab-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.agent-tab-stage {
  position: relative;
  display: grid;
  min-height: 0;
  flex: 1;
  place-items: center;
  overflow: hidden;
  padding: var(--space-2);
  background: rgb(var(--bg-inset));
}

.agent-tab[data-interactive] .agent-tab-stage {
  box-shadow: inset 0 0 0 2px rgb(var(--ok) / 0.6);
}

.agent-tab-canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: default;
}

.agent-tab[data-interactive] .agent-tab-canvas {
  cursor: crosshair;
}

.agent-tab-canvas[data-phase='connecting'],
.agent-tab-canvas[data-phase='error'] {
  visibility: hidden;
}

/* Receives keys and IME text while the user has taken over. */
.agent-tab-keyboard {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  resize: none;
}

.agent-tab-note {
  position: absolute;
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.agent-tab-hint {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  left: var(--space-3);
  margin: 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1) / 0.92);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: center;
  pointer-events: none;
}
</style>
