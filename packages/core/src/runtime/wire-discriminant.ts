import type { RuntimeEvent } from './types'

/** Runtime discriminants accepted at the renderer/ACP wire boundary. */
export const RUNTIME_EVENT_NAMES = [
  'agent_thought',
  'ask_answered',
  'ask_request',
  'assistant_done',
  'context_projection',
  'context_usage',
  'control_mode_update',
  'environment_changed',
  'environment_install_completed',
  'environment_install_failed',
  'environment_install_progress',
  'environment_install_started',
  'error',
  'git_operation_completed',
  'goal_blocked',
  'goal_cancelled',
  'goal_completed',
  'goal_created',
  'goal_evidence_recorded',
  'goal_gate_evaluated',
  'goal_paused',
  'goal_policy_stopped',
  'goal_resumed',
  'goal_runtime_update',
  'hook_decision_applied',
  'hook_run_completed',
  'hook_run_failed',
  'hook_run_progress',
  'hook_run_started',
  'interaction_cancelled',
  'mcp_connection_state',
  'message_delta',
  'message_tombstoned',
  'model_attempt_cancelled',
  'model_attempt_failed',
  'model_attempt_started',
  'model_attempt_succeeded',
  'model_provider_retry',
  'model_route_fallback',
  'plan_approved',
  'plan_comment_added',
  'plan_draft',
  'plan_draft_delta',
  'plan_entry_decision',
  'plan_execution_settled',
  'plan_runtime_update',
  'plan_step_update',
  'plan_verification_done',
  'plan_verification_start',
  'process_containment',
  'profile_onboarding_status_changed',
  'project_process_update',
  'prompt_cancelled',
  'prompt_dequeued',
  'prompt_interjected',
  'prompt_queued',
  'ready',
  'record_degraded',
  'research_validation',
  'runtime_task_cancelled',
  'scheduler_job_update',
  'scheduler_run_cancelled',
  'scheduler_run_done',
  'scheduler_run_error',
  'scheduler_run_interrupted',
  'scheduler_run_skipped',
  'scheduler_run_start',
  'skill_catalog_changed',
  'session_created',
  'session_title_updated',
  'subagent_delta',
  'subagent_done',
  'subagent_error',
  'subagent_start',
  'subagent_tool_call',
  'subagent_tool_error',
  'subagent_tool_result',
  'task_cancelled',
  'task_done',
  'task_error',
  'task_output',
  'task_progress',
  'task_started',
  'team_member_update',
  'team_message',
  'team_run_delta',
  'team_run_done',
  'team_run_error',
  'team_run_start',
  'team_run_tool_call',
  'team_run_tool_error',
  'team_run_tool_result',
  'tool_call',
  'tool_error',
  'tool_result',
  'tool_run_cancelled',
  'tool_run_completed',
  'tool_run_failed',
  'tool_run_queued',
  'tool_run_started',
  'turn_change_snapshot',
  'turn_paused',
  'turn_phase',
  'turn_scope',
  'user_message',
  'website_preview_update',
] as const

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number]

type MissingRuntimeEventName = Exclude<RuntimeEvent['event'], RuntimeEventName>
type ExtraRuntimeEventName = Exclude<RuntimeEventName, RuntimeEvent['event']>
const _runtimeEventNamesCoverUnion: [MissingRuntimeEventName] extends [never]
  ? true
  : never = true
const _runtimeEventNamesDoNotInventEvents: [ExtraRuntimeEventName] extends [
  never,
]
  ? true
  : never = true
void _runtimeEventNamesCoverUnion
void _runtimeEventNamesDoNotInventEvents

const RUNTIME_EVENT_NAME_SET: ReadonlySet<string> = new Set(RUNTIME_EVENT_NAMES)

export function isRuntimeEventWire(input: unknown): input is RuntimeEvent {
  if (!input || typeof input !== 'object') return false
  const event = (input as { event?: unknown }).event
  return typeof event === 'string' && RUNTIME_EVENT_NAME_SET.has(event)
}
