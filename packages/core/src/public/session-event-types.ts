/**
 * Browser-safe session-log vocabulary for the renderer.
 *
 * `SessionEventMap` is extended by declaration merging in each domain
 * module. The type-only namespace imports below pull every augmenting module
 * into a consumer's type program so `SessionEvent` sees the full event
 * union, while emitting no runtime import (every line is `import type`).
 * Add a line here whenever a module adds a
 * `declare module '../session-log/types'` block.
 */

import type * as _agentInbox from '../harness/agent/inbox'
import type * as _agentModelPolicy from '../harness/agent/model-policy'
import type * as _agentRetry from '../harness/agent/retry'
import type * as _approvalPresets from '../harness/approval/presets'
import type * as _approvalService from '../harness/approval/service'
import type * as _compactionEvents from '../harness/compaction/events'
import type * as _computerUseEvents from '../harness/computer-use/events'
import type * as _goalTypes from '../harness/goal/types'
import type * as _hooksTypes from '../harness/hooks/types'
import type * as _jobsRegistry from '../harness/jobs/registry'
import type * as _memory from '../harness/memory/memory'
import type * as _planMode from '../harness/plan/plan-mode'
import type * as _projector from '../harness/projection/projector'
import type * as _agentInstructions from '../harness/prompt/agent-instructions'
import type * as _questions from '../harness/questions/service'
import type * as _sandboxPolicy from '../harness/sandbox/policy'
import type * as _subagentManager from '../harness/subagent/manager'
import type * as _workflowRecords from '../harness/workflow/records'

/** Keeps the augmenting modules referenced (the imports exist for their merges). */
export type SessionEventAugmentations = [
  typeof _agentInbox,
  typeof _agentModelPolicy,
  typeof _agentRetry,
  typeof _approvalPresets,
  typeof _approvalService,
  typeof _compactionEvents,
  typeof _computerUseEvents,
  typeof _goalTypes,
  typeof _hooksTypes,
  typeof _jobsRegistry,
  typeof _memory,
  typeof _planMode,
  typeof _projector,
  typeof _agentInstructions,
  typeof _questions,
  typeof _sandboxPolicy,
  typeof _subagentManager,
  typeof _workflowRecords,
]

export type {
  EpochHeader,
  JsonValue,
  RequestContext,
  RequestHeaderReason,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  SurfaceOp,
  TodoItem,
  TurnEndReason,
} from '../session-log/types'
export type {
  AssistantMessage,
  ContentBlock,
  ContentBlockType,
  FinishReason,
  ImageAttachmentRef,
  LlmFailure,
  Message,
  MessageSource,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from '../llm/types'
export type {
  SessionHistoryPage,
  WireSessionEvent,
  WireTruncation,
} from '../session-log/history'
export type {
  SessionLineage,
  SessionLineageEntry,
  SubagentChildView,
} from '../harness/host/session-views'
export type {
  SubagentMode,
  SubagentStopReason,
} from '../harness/subagent/manager'
