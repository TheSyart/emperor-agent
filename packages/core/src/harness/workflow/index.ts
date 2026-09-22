/**
 * Dynamic workflows (ported from dsh-workflow, dsh-workflow-worker-thread,
 * dsh-tool-workflow, and dsh-tool-ralph without the Cordis service seam):
 * a worker-thread engine that runs model-written orchestration scripts whose
 * `agent()` calls spawn in-process subagents, the `workflow` and `ralph`
 * tools, and durable run records for the Task panel.
 */

export { WorkflowEngine, WORKFLOW_ENGINE_DEFAULTS } from './engine'
export type { WorkflowEngineConfig } from './engine'
export { WorkflowError, isFatalWorkflowError } from './errors'
export { validateMeta } from './meta'
export { createSpawnChildProvider, resolveChildCallConfig } from './provider'
export {
  WorkflowRunFold,
  WorkflowRunRegistry,
  workflowTaskView,
  type WorkflowAgentRecord,
  type WorkflowRecordStatus,
  type WorkflowRunRecord,
  type WorkflowRunTool,
} from './records'
export {
  createRalphTool,
  createWorkflowTool,
  installWorkflow,
  RALPH_META,
  RALPH_SCRIPT,
  resolveRalphConfig,
  STANDARD_RALPH_MAX_ROUNDS,
  type RalphConfig,
} from './tools'
export type * from './types'
