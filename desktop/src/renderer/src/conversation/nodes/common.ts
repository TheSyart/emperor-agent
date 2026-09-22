import type { ConversationNodeContext } from '../assembler'
import {
  locationCoordinates,
  type ConversationLocation,
  type StepLocation,
  type TurnLocation,
} from '../locationIndex'
import type { ChatNode, ChatNodeKind, ChatNodeOf } from '../types'

/**
 * Relative positions around one durable event for synthetic nodes: an
 * interrupted assistant sits just before the closing boundary, its
 * interrupted tool follow-ups after it, and turn-level notices just before
 * the turn tail (anchored at turn/end).
 */
export const CHAT_SYNTHETIC_SEQ_OFFSETS = {
  interruptedAssistant: -0.9,
  interruptedFollowup: -0.8,
  turnNotice: -0.1,
} as const

/** Best loaded Location of a Context (start, else first match). */
export function contextLocation(
  context: ConversationNodeContext,
): ConversationLocation {
  return (
    context.start?.location ??
    context.matches[0]?.location ?? { kind: 'unresolved' }
  )
}

/** Build one chat Node with the engine-owned key. */
export function chatNode<Kind extends ChatNodeKind>(
  context: ConversationNodeContext,
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeOf<Kind>['data'],
  options: {
    readonly location?: ConversationLocation
    readonly visibility?: 'visible' | 'hidden'
  } = {},
): ChatNodeOf<Kind> {
  const { turn, step } = locationCoordinates(
    options.location ?? contextLocation(context),
  )
  const node = {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat' as const,
    anchorSeq,
    visibility: options.visibility ?? 'visible',
    turn,
    step,
    data,
  }
  return node as unknown as ChatNodeOf<Kind>
}

/** Closed step or turn boundary owning a Location, if any. */
export function closedBoundary(
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

/** Turn of a Location, when resolved. */
export function turnOf(
  location: ConversationLocation | undefined,
): TurnLocation | undefined {
  return location?.kind === 'turn' || location?.kind === 'step'
    ? location.turn
    : undefined
}

/** Step of a Location, when resolved. */
export function stepOf(
  location: ConversationLocation | undefined,
): StepLocation | undefined {
  return location?.kind === 'step' ? location.step : undefined
}

/** Type guard used by consumers dispatching on node kind. */
export function isChatNodeKind<Kind extends ChatNodeKind>(
  node: ChatNode | undefined,
  kind: Kind,
): node is ChatNodeOf<Kind> {
  return node?.kind === kind
}
