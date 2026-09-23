// Pure ChatTimeline logic: the running-turn status label, bottom-follow
// geometry, the turn scrubber ticks, and the markdown fence split used by
// the assistant body.
import type { ChatNode, ChatSnapshot } from '../../conversation/types'
import { toolView } from './tools/registry'

/** Pixels from the floor that still count as "at the bottom" (dsh 24 + 1). */
export const FOLLOW_THRESHOLD = 25

/** Whether a scroll position sits on the floor. */
export function isAtBottom(el: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  const floor = Math.max(0, el.scrollHeight - el.clientHeight)
  return floor - el.scrollTop <= FOLLOW_THRESHOLD
}

/** Last visible node of the snapshot (the flow tip). */
function tipNode(snapshot: ChatSnapshot): ChatNode | undefined {
  for (let index = snapshot.order.length - 1; index >= 0; index--) {
    const key = snapshot.order[index]
    const node = key === undefined ? undefined : snapshot.nodes.get(key)
    if (node !== undefined) return node
  }
  return undefined
}

/**
 * One-line status for the running turn, derived from the flow tip: the
 * streaming block kind, the running tool, a pending retry or compaction.
 */
export function turnStatusLabel(snapshot: ChatSnapshot): string {
  const node = tipNode(snapshot)
  if (node === undefined) return '思考中…'
  switch (node.kind) {
    case 'assistant': {
      if (node.data.status !== 'running') return '思考中…'
      const last = node.data.blocks.at(-1)
      if (last?.kind === 'text') return '正在回复…'
      if (last?.kind === 'tool-call') return '准备调用工具…'
      return '思考中…'
    }
    case 'tool': {
      if (node.data.status !== 'running') return '思考中…'
      if (node.data.question !== undefined) return '等待你的回答…'
      if (node.data.approvals.some((a) => a.outcome === undefined))
        return '等待审批…'
      if (node.data.subagent?.status === 'running') return '子代理运行中…'
      if (node.data.workflow?.status === 'running') return '工作流运行中…'
      return `${toolView(node.data.name).title(node.data)}中…`
    }
    case 'retry':
      return node.data.current.state === 'scheduled'
        ? '等待重试…'
        : '重新请求中…'
    case 'fallback':
      return '切换备用模型…'
    case 'compaction':
      return node.data.status === 'running' ? '压缩上下文…' : '思考中…'
    case 'hook':
      return node.data.status === 'running' ? '运行 Hook…' : '思考中…'
    case 'workflowRun':
      return node.data.status === 'running' ? '工作流运行中…' : '思考中…'
    default:
      return '思考中…'
  }
}

/** Keys of assistant rows directly followed by their turn tail. */
export function closingAssistantKeys(
  order: readonly string[],
  nodes: ReadonlyMap<string, ChatNode>,
): Set<string> {
  const keys = new Set<string>()
  for (let index = 1; index < order.length; index++) {
    const node = nodes.get(order[index] ?? '')
    if (node?.kind !== 'turnTail') continue
    const previous = order[index - 1]
    if (previous !== undefined && nodes.get(previous)?.kind === 'assistant')
      keys.add(previous)
  }
  return keys
}

// ── turn scrubber ─────────────────────────────────────────────────────

/** Characters of the prompt a scrubber tooltip shows. */
export const TURN_TICK_LABEL_CHARS = 40

/** One scrubber tick: a user message of the loaded window. */
export interface TurnTick {
  /** Chat node key (scroll target). */
  key: string
  /** Position in `snapshot.order`. */
  index: number
  /** 1-based turn number within the window. */
  turn: number
  /** First 40 characters of the prompt (whitespace collapsed). */
  label: string
}

/** Prompt preview: whitespace collapsed, cut to `max` characters. */
export function promptPreview(
  text: string,
  max = TURN_TICK_LABEL_CHARS,
): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/** One tick per user message in render order. */
export function turnTicks(
  snapshot: Pick<ChatSnapshot, 'order' | 'nodes'> | null | undefined,
): TurnTick[] {
  if (!snapshot) return []
  const ticks: TurnTick[] = []
  snapshot.order.forEach((key, index) => {
    const node = snapshot.nodes.get(key)
    if (node?.kind !== 'user') return
    const text = promptPreview(node.data.text)
    ticks.push({
      key,
      index,
      turn: ticks.length + 1,
      label:
        text ||
        (node.data.attachments.length > 0
          ? '（附件）'
          : `第 ${ticks.length + 1} 轮`),
    })
  })
  return ticks
}

/**
 * Tick of the turn the reader is in: the last tick at or above the first
 * visible row (the first tick while the reader is above every prompt).
 * -1 without ticks.
 */
export function activeTurnTick(
  ticks: readonly TurnTick[],
  order: readonly string[],
  firstVisibleKey: string | null,
): number {
  if (ticks.length === 0) return -1
  const position =
    firstVisibleKey === null ? -1 : order.indexOf(firstVisibleKey)
  if (position < 0) return ticks.length - 1
  let active = 0
  for (let index = 0; index < ticks.length; index++) {
    if ((ticks[index]?.index ?? Infinity) > position) break
    active = index
  }
  return active
}

// ── markdown fences ─────────────────────────────────────────────────────

export type MarkdownSegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | {
      readonly kind: 'code'
      readonly lang: string
      readonly code: string
      /** Fence not closed yet (streaming). */
      readonly open: boolean
    }

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/u

/**
 * Split markdown into prose and fenced code so fences render through the
 * CodeBlock primitive. An unclosed trailing fence (streaming) is code.
 */
export function splitMarkdownFences(source: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  const lines = source.split('\n')
  let prose: string[] = []
  let index = 0
  const flushProse = (): void => {
    const text = prose.join('\n')
    if (text.trim() !== '') segments.push({ kind: 'markdown', text })
    prose = []
  }
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const open = FENCE_OPEN.exec(line)
    if (open === null) {
      prose.push(line)
      index++
      continue
    }
    const fence = open[2] ?? '```'
    const indent = open[1]?.length ?? 0
    const lang = open[3] ?? ''
    const body: string[] = []
    index++
    let closed = false
    while (index < lines.length) {
      const inner = lines[index] ?? ''
      const trimmed = inner.trim()
      const marker = fence[0] ?? '`'
      if (
        trimmed.length >= fence.length &&
        [...trimmed].every((char) => char === marker)
      ) {
        closed = true
        index++
        break
      }
      body.push(
        indent > 0
          ? inner.replace(new RegExp(`^ {0,${indent}}`, 'u'), '')
          : inner,
      )
      index++
    }
    flushProse()
    segments.push({ kind: 'code', lang, code: body.join('\n'), open: !closed })
  }
  flushProse()
  return segments
}
