import type { ConversationDefinition } from '../assembler'
import { assistantDefinition } from './assistant'
import { nextStepInboxDefinition, userMetaDefinition } from './ledgers'
import { contextDefinition, userDefinition } from './messages'
import {
  costCapDefinition,
  fallbackDefinition,
  goalDefinition,
  hookDefinition,
  retryDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
} from './notices'
import { toolDefinition } from './tool'
import {
  compactionDefinition,
  requestContextFactDefinition,
  todosFactDefinition,
  turnTailDefinition,
} from './turn'
import { workflowRunDefinition } from './workflow'

/** Every Definition feeding the `chat` target (plus its state-only ledgers). */
export const CHAT_DEFINITIONS: readonly ConversationDefinition[] = [
  userMetaDefinition,
  nextStepInboxDefinition,
  userDefinition,
  contextDefinition,
  assistantDefinition,
  toolDefinition,
  retryDefinition,
  fallbackDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
  costCapDefinition,
  compactionDefinition,
  hookDefinition,
  goalDefinition,
  workflowRunDefinition,
  turnTailDefinition,
  todosFactDefinition,
  requestContextFactDefinition,
] as readonly ConversationDefinition[]
