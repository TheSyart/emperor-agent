// Pure ChatTimeline logic: the running-turn status label, bottom-follow
// geometry, and the markdown fence split used by the assistant body.
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
