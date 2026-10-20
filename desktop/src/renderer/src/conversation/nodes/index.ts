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
  turnBudgetDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
} from './notices'
import { toolDefinition } from './tool'
import { turnFilesDefinition } from './turnFiles'
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
  turnBudgetDefinition,
  costCapDefinition,
  compactionDefinition,
  hookDefinition,
  goalDefinition,
  workflowRunDefinition,
  turnTailDefinition,
  turnFilesDefinition,
  todosFactDefinition,
  requestContextFactDefinition,
] as readonly ConversationDefinition[]
