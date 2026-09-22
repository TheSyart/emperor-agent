import type { ConversationDefinition } from '../../../conversation/assembler'
import {
  trajectoryAssistantDefinition,
  trajectoryTurnEndDefinition,
} from './assistant'
import {
  trajectoryCompactionDefinition,
  trajectorySessionEndDefinition,
} from './compaction'
import {
  trajectoryEventContextDefinition,
  trajectoryMessageDefinition,
} from './messages'
import {
  trajectoryRequestContextDefinition,
  trajectoryRequestHeaderDefinition,
} from './requestHeader'
import {
  trajectoryToolDefinition,
  trajectoryWorkflowRunDefinition,
} from './tool'

/**
 * Every Definition feeding the `trajectory` target. The user/steering
 * classification reads the chat target's `user-meta` and `inbox-next-step`
 * ledgers, so these are always assembled beside the chat Definitions.
 */
export const TRAJECTORY_DEFINITIONS: readonly ConversationDefinition[] = [
  trajectoryMessageDefinition,
  trajectoryEventContextDefinition,
  trajectoryRequestHeaderDefinition,
  trajectoryRequestContextDefinition,
  trajectoryAssistantDefinition,
  trajectoryTurnEndDefinition,
  trajectoryToolDefinition,
  trajectoryWorkflowRunDefinition,
  trajectoryCompactionDefinition,
  trajectorySessionEndDefinition,
] as readonly ConversationDefinition[]

export {
  trajectoryAssistantDefinition,
  trajectoryCompactionDefinition,
  trajectoryEventContextDefinition,
  trajectoryMessageDefinition,
  trajectoryRequestContextDefinition,
  trajectoryRequestHeaderDefinition,
  trajectorySessionEndDefinition,
  trajectoryToolDefinition,
  trajectoryTurnEndDefinition,
  trajectoryWorkflowRunDefinition,
}
