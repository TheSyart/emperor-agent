// Pure helpers over raw session-log events shared by the node Definitions.
// Browser-safe re-implementations of the core surface helpers (the renderer
// imports core only as types).
import type {
  ContentBlock,
  LlmFailure,
  SessionEventType,
  StreamChunk,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type { AssistantBlock } from './types'

/** Narrow a raw event to one type. */
export function isEvent<Type extends SessionEventType>(
  event: WireSessionEvent,
  type: Type,
): event is Extract<WireSessionEvent, { type: Type }> {
  return event.type === type
}

/** Append-origin surface event (never a compaction replacement copy). */
export function isAppendSurfaceEvent(event: WireSessionEvent): boolean {
  return (event as { surfaceOp?: unknown }).surfaceOp === 'append'
}

/** Surface replacement (compaction checkpoint). */
export function isReplacementSurfaceEvent(event: WireSessionEvent): boolean {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  return typeof op === 'object' && op !== null
}

/** Chunks that carry a visible token (TTFT marker). */
export function isTokenDelta(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
    return chunk.text !== ''
  if (chunk.type === 'tool-call-delta')
    return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

/** Classify one core content block for chat (tool-call args dropped). */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text':
      return { kind: 'text', text: block.text }
    case 'reasoning':
      return { kind: 'reasoning', text: block.text }
    case 'image':
      return { kind: 'image', attachment: block.attachment }
    case 'tool-call':
      return { kind: 'tool-call', callId: String(block.id), name: block.name }
    default:
      return { kind: 'other', block }
  }
}

export function toAssistantBlocks(
  content: readonly ContentBlock[],
): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/** Empty block for a streamed `block-start`. */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text':
      return { kind: 'text', text: '' }
    case 'reasoning':
      return { kind: 'reasoning', text: '' }
    case 'tool-call':
      return { kind: 'tool-call', callId: '', name: '' }
    default:
      return { kind: 'other', block: null }
  }
}

/**
 * Fold one stream chunk into sparse assistant blocks (index-addressed).
 * Returns the same array when the chunk carries no visible change.
 */
export function foldChunk(
  blocks: readonly (AssistantBlock | undefined)[],
  chunk: StreamChunk,
): readonly (AssistantBlock | undefined)[] {
  switch (chunk.type) {
    case 'block-start': {
      const next = [...blocks]
      next[chunk.index] = emptyAssistantBlock(chunk.blockType)
      return next
    }
    case 'text-delta': {
      const next = [...blocks]
      const previous = blocks[chunk.index]
      next[chunk.index] = {
        kind: 'text',
        text: (previous?.kind === 'text' ? previous.text : '') + chunk.text,
      }
      return next
    }
    case 'reasoning-delta': {
      const next = [...blocks]
      const previous = blocks[chunk.index]
      next[chunk.index] = {
        kind: 'reasoning',
        text:
          (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text,
      }
      return next
    }
    case 'tool-call-delta': {
      const next = [...blocks]
      const previous = blocks[chunk.index]
      const base =
        previous?.kind === 'tool-call'
          ? previous
          : { kind: 'tool-call' as const, callId: '', name: '' }
      next[chunk.index] = {
        kind: 'tool-call',
        callId: base.callId || String(chunk.id),
        name: chunk.name ?? base.name,
      }
      return next
    }
    case 'block-end': {
      const next = [...blocks]
      next[chunk.index] = toAssistantBlock(chunk.block)
      return next
    }
    default:
      return blocks
  }
}

export function compactBlocks(
  blocks: readonly (AssistantBlock | undefined)[],
): AssistantBlock[] {
  return blocks.filter((block): block is AssistantBlock => block !== undefined)
}

/** Text/reasoning with content, or any image/other block. */
export function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'tool-call') return false
    if (block.kind === 'text' || block.kind === 'reasoning')
      return block.text.trim() !== ''
    return true
  })
}

/** Joined text of the text blocks of some content. */
export function contentText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/** Human-readable failure line. */
export function failureMessage(failure: LlmFailure): string {
  const status = failure.status === undefined ? '' : ` (${failure.status})`
  return `${failure.message || failure.code}${status}`
}

/** Safe non-negative integer read. */
export function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}
