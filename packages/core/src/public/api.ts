export { CoreApi } from '../api/core-api'
export type { CoreApiCreateOptions } from '../api/core-api'
export { coreOperationKeys, invokeCoreOperation } from '../api/operations'
export type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '../api/operations'
export { CoreUnavailableError } from '../runtime/lifecycle'
export { EnvironmentError } from '../environment/errors'
export { PromptQueueFullError } from '../agent/loop'
export type {
  CommandCompletion,
  CommandDescriptor,
  CommandInvocationResult,
  CommandSurface,
} from '../commands/types'
export {
  ControlMode,
  InteractionKind,
  InteractionStatus,
} from '../control/models'
export type { HooksConfigV2 } from '../hooks/models'
export type { MemoryScope } from '../memory/patch'
export type {
  CompactionDecision,
  DiscardedItem,
} from '../memory/compaction-models'
export type { GitFileStatus, GitStatusResult } from '../workspace/git'
export type { GitWorktreeSummary } from '../workspace/git-worktrees'
export type { PullRequestSummary } from '../workspace/git-pull-requests'
export type {
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
} from '../workspace/files'
export type { WorkspaceSnapshot } from '../workspace/snapshot'
export type { TerminalEvent, TerminalSummary } from '../workspace/terminal'
