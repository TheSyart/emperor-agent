// The `trajectory` target as a conversation-assembler extension. Kept free
// of layout/search/preview code so the conversation store can register it
// lazily without pulling the ledger projections into the chat bundle.
import type { ConversationAssembler } from '../../conversation/assembler'
import {
  createConversationAssembler,
  type ConversationExtensions,
} from '../../conversation/chatSnapshot'
import type { TrajectorySnapshot } from './contract'
import { TRAJECTORY_DEFINITIONS } from './definitions'
import {
  EMPTY_TRAJECTORY_SNAPSHOT,
  trajectoryViewDefinition,
} from './snapshotBuilder'

/** Target name of the trajectory view. */
export const TRAJECTORY_TARGET = 'trajectory'

/** Trajectory Definitions and view builder, assembled beside chat. */
export const TRAJECTORY_EXTENSIONS: ConversationExtensions = {
  definitions: TRAJECTORY_DEFINITIONS,
  views: [trajectoryViewDefinition],
}

/** New per-session assembler with the chat and trajectory targets. */
export function createTrajectoryAssembler(): ConversationAssembler {
  return createConversationAssembler(TRAJECTORY_EXTENSIONS)
}

/** Latest trajectory snapshot of an assembler (empty before its first flush). */
export function trajectorySnapshotOf(
  assembler: ConversationAssembler,
): TrajectorySnapshot {
  return (
    assembler.snapshot<TrajectorySnapshot | undefined>(TRAJECTORY_TARGET) ??
    EMPTY_TRAJECTORY_SNAPSHOT
  )
}
