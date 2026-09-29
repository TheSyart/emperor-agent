/**
 * Agent tabs in the Browser pane (computer use, spec 00 §13): which of the
 * status targets belong to this session's pane, how their control state
 * reads, which user controls apply, and how pointer positions on the preview
 * map back to page CSS pixels.
 */
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'

export type AgentTabControlAction =
  'pause' | 'resume' | 'takeover' | 'handback' | 'close'

export type AgentTabTone = 'active' | 'paused' | 'user' | 'stopped'

export interface AgentTab {
  readonly targetId: string
  readonly title: string
  readonly host: string
  readonly url: string
  readonly control: UiTargetView['control']
  readonly recovering: boolean
  readonly label: string
  readonly tone: AgentTabTone
  readonly actions: readonly AgentTabControlAction[]
  /** Input on the preview reaches the page (the user took it over). */
  readonly interactive: boolean
}

const LIVE_STATES = new Set<UiTargetView['state']>([
  'created',
  'attached',
  'paused',
  'recovering',
])

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function describe(target: UiTargetView): Pick<AgentTab, 'label' | 'tone'> {
  switch (target.control) {
    case 'user-takeover':
      return { label: '你在操作', tone: 'user' }
    case 'paused':
      return { label: '已暂停', tone: 'paused' }
    case 'stopped':
      return { label: '已急停', tone: 'stopped' }
    default:
      return target.state === 'recovering'
        ? { label: '正在恢复', tone: 'paused' }
        : { label: 'Agent 操作中', tone: 'active' }
  }
}

function actionsFor(control: UiTargetView['control']): AgentTabControlAction[] {
  switch (control) {
    case 'agent':
      return ['pause', 'takeover', 'close']
    case 'paused':
      return ['resume', 'takeover', 'close']
    case 'user-takeover':
      return ['handback', 'close']
    default:
      // Stopped: only the global resume lets the Agent act again.
      return ['takeover', 'close']
  }
}

export function toAgentTab(target: UiTargetView): AgentTab {
  return {
    targetId: target.targetId,
    title: target.title || hostOf(target.url) || '新标签页',
    host: hostOf(target.url),
    url: target.url,
    control: target.control,
    recovering: target.state === 'recovering',
    ...describe(target),
    actions: actionsFor(target.control),
    interactive: target.control === 'user-takeover',
  }
}

/** The live embedded-browser tabs this session's Agent holds. */
export function agentTabsFor(
  status: ComputerUseStatusView | null,
  sessionId: string | null | undefined,
): AgentTab[] {
  if (!status || !sessionId || !Array.isArray(status.targets)) return []
  return status.targets
    .filter(
      (target) =>
        target.driver === 'embedded-browser' &&
        target.ownerSessionId === sessionId &&
        LIVE_STATES.has(target.state),
    )
    .map(toAgentTab)
}

export const AGENT_TAB_ACTION_LABELS: Readonly<
  Record<AgentTabControlAction, string>
> = {
  pause: '暂停',
  resume: '继续',
  takeover: '接管',
  handback: '交还',
  close: '关闭标签页',
}

export interface PreviewRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Map a pointer on the drawn frame to page CSS pixels. The frame is drawn
 * `object-fit: contain`, so letterboxing is subtracted; null outside it.
 */
export function previewPoint(
  rect: PreviewRect,
  viewport: { readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  if (viewport.width <= 0 || viewport.height <= 0) return null
  const scale = Math.min(
    rect.width / viewport.width,
    rect.height / viewport.height,
  )
  const drawnWidth = viewport.width * scale
  const drawnHeight = viewport.height * scale
  const offsetX = rect.left + (rect.width - drawnWidth) / 2
  const offsetY = rect.top + (rect.height - drawnHeight) / 2
  const x = (clientX - offsetX) / scale
  const y = (clientY - offsetY) / scale
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null
  return { x: Math.round(x), y: Math.round(y) }
}

const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/**
 * How a keydown on the taken-over preview reaches the page: printable
 * characters without shortcuts go as text; named keys and shortcut
 * combinations as key events; anything else is not forwarded.
 */
export function keyInput(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}):
  | { kind: 'text'; text: string }
  | {
      kind: 'key'
      key: string
      modifiers: Array<'shift' | 'control' | 'alt' | 'meta'>
    }
  | null {
  const shortcut = event.ctrlKey || event.metaKey || event.altKey
  if (!shortcut && [...event.key].length === 1)
    return { kind: 'text', text: event.key }
  const modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = []
  if (event.shiftKey) modifiers.push('shift')
  if (event.ctrlKey) modifiers.push('control')
  if (event.altKey) modifiers.push('alt')
  if (event.metaKey) modifiers.push('meta')
  if (NAMED_KEYS.has(event.key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key))
    return { kind: 'key', key: event.key, modifiers }
  if (shortcut && /^[a-z0-9]$/i.test(event.key))
    return { kind: 'key', key: event.key, modifiers }
  return null
}
