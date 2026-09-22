// Helpers shared by the trajectory Definitions: the target envelope, compact
// locations and the argument-preserving assistant block fold.
import type { ContentBlock, StreamChunk } from '@emperor/core/runtime-contract'
import type {
  ConversationMatch,
  ConversationNodeContext,
} from '../../../conversation/assembler'
import type { ConversationLocation } from '../../../conversation/locationIndex'
import type {
  TrajectoryAssistantBlock,
  TrajectoryContribution,
  TrajectoryConversationViewNode,
  TrajectoryLocation,
} from '../contract'

/** Compact a resolved engine Location to its coordinates. */
export function trajectoryLocation(
  location: ConversationLocation | undefined,
): TrajectoryLocation {
  if (location === undefined) return { kind: 'unresolved' }
  if (location.kind === 'step')
    return {
      kind: 'step',
      turn: location.turn.turn,
      step: location.step.step,
    }
  if (location.kind === 'turn')
    return { kind: 'turn', turn: location.turn.turn }
  return location.kind === 'session'
    ? { kind: 'session' }
    : { kind: 'unresolved' }
}

/**
 * Wrap one contribution in the engine-owned target envelope.
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param data - Trajectory-specific contribution payload.
 */
export function trajectoryNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'trajectory',
    anchorSeq,
    visibility: 'visible',
    location: trajectoryLocation(
      context.start?.location ?? context.matches[0]?.location,
    ),
    data,
  }
}

/** Closed step or turn boundary of a Location, if any. */
export function closedBoundaryOf(
  location: ConversationLocation | undefined,
): { seq: number; time: number } | undefined {
  if (location === undefined) return undefined
  if (
    location.kind === 'step' &&
    location.step.status === 'closed' &&
    location.step.end !== undefined
  )
    return location.step.end
  if (
    (location.kind === 'step' || location.kind === 'turn') &&
    location.turn.status === 'closed' &&
    location.turn.end !== undefined
  )
    return location.turn.end
  return undefined
}

/** Turn/step of a match from its Location (0 when unresolved). */
export function matchCoordinates(match: ConversationMatch): {
  turn: number
  step: number
} {
  const location = match.location
  return {
    turn:
      location.kind === 'step' || location.kind === 'turn'
        ? location.turn.turn
        : 0,
    step: location.kind === 'step' ? location.step.step : 0,
  }
}

/** Classify one core content block, keeping tool-call arguments. */
export function toTrajectoryBlock(
  block: ContentBlock,
): TrajectoryAssistantBlock {
  switch (block.type) {
    case 'text':
      return { kind: 'text', text: block.text }
    case 'reasoning':
      return { kind: 'reasoning', text: block.text }
    case 'image':
      return { kind: 'image', attachment: block.attachment }
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: String(block.id),
        name: block.name,
        argsRaw: block.arguments,
      }
    default:
      return { kind: 'other', block }
  }
}

export function toTrajectoryBlocks(
  content: readonly ContentBlock[],
): TrajectoryAssistantBlock[] {
  return content.map(toTrajectoryBlock)
}

function emptyBlock(blockType: string): TrajectoryAssistantBlock {
  switch (blockType) {
    case 'text':
      return { kind: 'text', text: '' }
    case 'reasoning':
      return { kind: 'reasoning', text: '' }
    case 'tool-call':
      return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default:
      return { kind: 'other', block: null }
  }
}

/**
 * Fold one stream chunk into sparse assistant blocks (index-addressed).
 * Returns the same array when the chunk carries no block change.
 */
export function foldTrajectoryChunk(
  blocks: readonly (TrajectoryAssistantBlock | undefined)[],
  chunk: StreamChunk,
): readonly (TrajectoryAssistantBlock | undefined)[] {
  switch (chunk.type) {
    case 'block-start': {
      const next = [...blocks]
      next[chunk.index] = emptyBlock(chunk.blockType)
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
          : { callId: '', name: '', argsRaw: '' }
      next[chunk.index] = {
        kind: 'tool-call',
        callId: base.callId || String(chunk.id),
        name: chunk.name ?? base.name,
        argsRaw: base.argsRaw + chunk.argumentsDelta,
      }
      return next
    }
    case 'block-end': {
      const next = [...blocks]
      next[chunk.index] = toTrajectoryBlock(chunk.block)
      return next
    }
    default:
      return blocks
  }
}

export function compactTrajectoryBlocks(
  blocks: readonly (TrajectoryAssistantBlock | undefined)[],
): TrajectoryAssistantBlock[] {
  return blocks.filter(
    (block): block is TrajectoryAssistantBlock => block !== undefined,
  )
}

/** Text/reasoning with content, or any image/other block. */
export function hasVisibleTrajectoryContent(
  blocks: readonly TrajectoryAssistantBlock[],
): boolean {
  return blocks.some((block) => {
    if (block.kind === 'tool-call') return false
    if (block.kind === 'text' || block.kind === 'reasoning')
      return block.text.trim() !== ''
    return true
  })
}

/** Any content that proves an interrupted step produced output. */
export function hasInterruptionEvidence(
  blocks: readonly TrajectoryAssistantBlock[],
): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning')
      return block.text.trim() !== ''
    return true
  })
}

/** One text content block. */
export function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}
