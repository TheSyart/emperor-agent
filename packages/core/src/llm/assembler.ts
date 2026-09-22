/**
 * Incremental chunk-to-message assembler: the single canonical assembly
 * algorithm the agent loop uses to build an assistant message from a chunk
 * stream while logging the raw chunks (ported from dsh-llm assembler.ts).
 */

import { assertNever } from './never'
import { createMessage } from './message'
import type { Message, MessageSource } from './message'
import type {
  ContentBlock,
  FinishReason,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
} from './types'

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: string
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

/**
 * Assembles raw {@link StreamChunk}s into complete content blocks. Tolerant
 * of delta-only protocols; deltas for an index already closed by `block-end`
 * are ignored so a misbehaving adapter cannot corrupt a completed block.
 */
export class BlockAssembler {
  private readonly partials = new Map<number, PartialBlock>()
  private readonly order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(
          chunk.index,
          chunk.type === 'text-delta' ? 'text' : 'reasoning',
        )
        if (partial.block) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      default:
        assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.toolCallId || `call-${index}`,
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments,
        }
      default:
        throw new Error(
          `cannot assemble incomplete block of type "${partial.blockType}"`,
        )
    }
  }

  private partialAt(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial)
      throw new Error(
        `BlockAssembler invariant violated: no partial for index ${index}`,
      )
    return partial
  }

  /**
   * One shared keep/drop decision: max-token truncation drops tool calls
   * that cannot be executed safely. Blocks and replay metadata both derive
   * from this result, so they cannot disagree.
   */
  private assembled(): {
    blocks: ContentBlock[]
    replay: ReplayEnvelope | undefined
  } {
    const all = this.order.map((index) =>
      this.assemble(this.partialAt(index), index),
    )
    const kept =
      this.finish.kind === 'max-tokens'
        ? all.map((block) => block.type !== 'tool-call')
        : undefined
    const blocks =
      kept === undefined ? all : all.filter((_, position) => kept[position])
    const envelope = this._replayState
    if (envelope?.blocks === undefined) return { blocks, replay: envelope }
    if (envelope.blocks.length !== all.length)
      return { blocks, replay: undefined }
    return {
      blocks,
      replay:
        kept === undefined || blocks.length === all.length
          ? envelope
          : {
              response: envelope.response,
              blocks: envelope.blocks.filter((_, position) => kept[position]),
            },
    }
  }

  /** All blocks seen so far, in stream order. */
  blocks(): ContentBlock[] {
    return this.assembled().blocks
  }

  /**
   * The prefix an interrupted stream can safely finalize: text/reasoning
   * blocks with non-whitespace content. Tool calls are omitted because
   * interruption precedes dispatch.
   */
  interruptedBlocks(): ContentBlock[] {
    return this.order
      .map((index) => {
        const partial = this.partialAt(index)
        const type = partial.block?.type ?? partial.blockType
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter(
        (block): block is ContentBlock =>
          (block?.type === 'text' || block?.type === 'reasoning') &&
          block.text.trim() !== '',
      )
  }

  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  get replayState(): ReplayEnvelope | undefined {
    return this.assembled().replay
  }

  message(
    source: MessageSource = { kind: 'context', producer: 'llm/assembler' },
  ): Message {
    return createMessage({
      role: 'assistant' as const,
      content: this.blocks(),
      source,
    })
  }
}
