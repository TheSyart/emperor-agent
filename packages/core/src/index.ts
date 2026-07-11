/**
 * @emperor/core — TS 迁移核心库的公共出口。
 * 随波次推进逐步补全。W00 基础 + W01/W02 配置与 provider 层已落地。
 */
export * from './errors'
export * from './util/ids'
export * from './util/strings'
export * from './util/time'
export * from './util/log'
export * from './events/bus'
export * from './store/atomic-json'
export * from './store/file-lock'
export * from './store/jsonl'
export * from './providers/registry'
export * from './providers/base'
export * from './providers/factory'
export * from './prompts/manifest'
export * from './config/local-config'
export * from './config/model-config'
export * from './model/router'
export * from './tools/schema'
export * from './tools/base'
export * from './tools/registry'
export * from './tools/resolvers'
export * from './tools/filesystem'
export * from './tools/search'
export * from './tools/builtin'
export * from './tools/dispatch'
export * from './tools/web-search'
export * from './context/pipeline'
// agent core (W03)
export * from './agent/query-state'
export * from './agent/turn-state'
export * from './agent/model-caller'
export * from './agent/runner'
export * from './agent/context-builder'
export * from './agent/runner-factory'
export * from './agent/loop'
export { ToolExecutionEngine } from './tools/execution'
// permissions (W05)
export * from './permissions/models'
export * from './permissions/resolve-profile'
export * from './permissions/pipeline'
export * from './permissions/policy'
export * from './permissions/manager'
export * from './permissions/workspace-policy'
// plans (W05)
export * from './plans/verification'
export * from './plans/models'
export * from './plans/evidence'
export * from './plans/reviewer'
export * from './plans/quality'
export * from './plans/execution-state'
export * from './plans/store'
export * from './plans/context'
// control (W05)
export * from './control/models'
export * from './control/store'
export * from './control/exceptions'
export * from './control/clarification'
export * from './control/plan-policy'
export * from './control/policy'
export * from './control/tools'
export * from './control/manager'
// memory (W06)
export * from './memory/history'
export * from './memory/store'
export * from './memory/versions'
export * from './memory/compactor'
export * from './memory/token-tracker'
export * from './memory/time-utc8'
export * from './memory/compaction-models'
// sessions (W07)
export * from './sessions/conversation'
export * from './sessions/store'
export * from './sessions/constants'
export * from './sessions/migrate'
export * from './sessions/title'
// runtime / tasks / projects (W14)
export * from './runtime/events'
export * from './runtime/types'
export * from './runtime/store'
export * from './runtime/active'
export * from './runtime/migrate-state-root'
export * from './runtime/paths'
export * from './runtime/resources'
export * from './environment/models'
export * from './environment/errors'
export * from './environment/catalog'
export * from './environment/download'
export * from './environment/jobs'
export * from './environment/macos-adapter'
export * from './environment/store'
export * from './environment/version'
export * from './environment/path'
export * from './environment/project-detector'
export * from './environment/process-runner'
export * from './environment/probe'
export * from './environment/snapshot'
export * from './hooks'
export * from './tasks/models'
export * from './tasks/store'
export * from './tasks/sidechain'
export * from './tasks/manager'
export * from './projects/store'
export {
  ProjectStateStore,
  DEFAULT_PROJECT_MEMORY_BLOCK,
  extractProjectMemoryBlock,
  replaceProjectMemoryBlock,
  type ProjectStateInput,
  type ProjectStateMetadata,
  type ProjectStatePaths,
} from './projects/state-store'
// subagents (W08)
export * from './subagents/spec'
export * from './subagents/registry'
export * from './subagents/dispatch-runner'
// scheduler (W09)
export {
  SchedulerStatus,
  SchedulerSchedule,
  SchedulerPayload,
  SchedulerRunRecord,
  SchedulerJobState,
  SchedulerJob,
  newJobId,
  validateJobId,
  computeNextRunMs,
  validateSchedule,
} from './scheduler/models'
export * from './scheduler/store'
export * from './scheduler/system-jobs'
export { SchedulerService } from './scheduler/service'
export * from './scheduler/tool'
export * from './scheduler/executor'
// attachments (W13)
export * from './attachments/store'
export * from './attachments/extract'
export * from './attachments/encode'
// managed media artifacts
export * from './media/store'
export * from './media/ingest'
// mcp (W11)
export * from './mcp/config'
export * from './mcp/connection'
export * from './mcp/adapter'
export * from './mcp/client'
// external bridge / watchlist (W12)
export * from './external/models'
export * from './external/adapter'
export * from './external/store'
export * from './external/service'
export * from './watchlist/models'
export * from './watchlist/store'
export * from './watchlist/service'
// in-process API / IPC boundary (W15)
export * from './api/core-api'
export * from './api/operations'
export * from './api/mutation-guard'
export * from './api/chat-service'
export * from './api/services/config-service'
export * from './api/services/diagnostics-service'
export * from './api/services/desktop-pet-service'
export * from './api/services/memory-service'
export * from './api/services/model-service'
export * from './api/services/skill-service'
export * from './api/services/team-service'
// team (W10)
export * from './team/models'
export * from './team/events'
export * from './team/store'
export * from './team/bus'
export * from './team/manager'
export * from './team/tools'
