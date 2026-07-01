export type RuntimeEventPayload = Record<string, unknown>

export interface RuntimeEventEnvelope {
  seq?: number
  ts?: number
  turn_id?: string
  client_message_id?: string
}

export type RuntimeEvent = RuntimeEventEnvelope & (
  | { event: 'ready'; model?: string; provider?: string; latest_seq?: number; replay_count?: number; resume_from?: number; busy?: boolean; control?: RuntimeEventPayload }
  | { event: 'user_message'; content?: string; attachments?: RuntimeEventPayload[]; source?: string; scheduler?: RuntimeEventPayload; ui_hidden?: boolean }
  | { event: 'message_delta'; delta?: string }
  | { event: 'agent_thought'; stage?: string; label?: string; summary?: string; source?: string; status?: 'done' | 'running' | string; tool_call_ids?: string[]; tool_names?: string[] }
  | { event: 'context_usage'; used?: number; max?: number; threshold?: number; usage_type?: string; model_role?: string; model?: string; provider?: string; route_reason?: string; estimated_input_tokens?: number }
  | { event: 'context_projection'; report?: RuntimeEventPayload; message_count?: number }
  | { event: 'model_route_fallback'; from_model?: string; to_model?: string; reason?: string; usage_type?: string }
  | { event: 'session_created'; session?: RuntimeEventPayload; client_draft_id?: string }
  | { event: 'session_title_updated'; session?: RuntimeEventPayload }
  | { event: 'external_inbound'; message?: RuntimeEventPayload }
  | { event: 'external_queued'; message?: RuntimeEventPayload; reason?: string }
  | { event: 'external_outbound_queued'; message?: RuntimeEventPayload }
  | { event: 'external_outbound_sent'; message?: RuntimeEventPayload; delivery?: RuntimeEventPayload }
  | { event: 'external_outbound_error'; message?: RuntimeEventPayload; error?: string }
  | { event: 'tool_call'; id?: string; name: string; arguments?: RuntimeEventPayload }
  | { event: 'tool_result'; id?: string; name?: string; summary?: string; artifacts?: RuntimeEventPayload[]; metadata?: RuntimeEventPayload; todos?: RuntimeEventPayload[]; is_error?: boolean }
  | { event: 'tool_error'; id?: string; name?: string; message?: string }
  | { event: 'tool_run_queued'; id?: string; name: string; arguments?: RuntimeEventPayload }
  | { event: 'tool_run_started'; id?: string; name: string }
  | { event: 'tool_run_completed'; id?: string; name: string; summary?: string; artifacts?: RuntimeEventPayload[]; metadata?: RuntimeEventPayload }
  | { event: 'tool_run_failed'; id?: string; name: string; message?: string }
  | { event: 'tool_run_cancelled'; id?: string; name: string; reason?: string }
  | { event: 'turn_phase'; phase?: string; sequence?: number; iteration?: number; detail?: RuntimeEventPayload }
  | { event: 'assistant_done'; content?: string }
  | { event: 'error'; message?: string; partial?: boolean }
  | { event: 'control_mode_update'; control?: RuntimeEventPayload }
  | { event: 'ask_request'; interaction?: RuntimeEventPayload }
  | { event: 'ask_answered'; interaction?: RuntimeEventPayload }
  | { event: 'plan_draft'; interaction?: RuntimeEventPayload }
  | { event: 'plan_draft_delta'; tool_call_id?: string; interaction?: RuntimeEventPayload }
  | { event: 'plan_comment_added'; interaction?: RuntimeEventPayload; comment?: string }
  | { event: 'plan_approved'; interaction?: RuntimeEventPayload; control?: RuntimeEventPayload; plan?: RuntimeEventPayload; todos?: RuntimeEventPayload[] }
  | { event: 'plan_entry_decision'; decision?: string; reason?: string; triggers?: string[]; suggested_questions?: string[]; recommended_readonly_scopes?: string[] }
  | { event: 'plan_runtime_update'; plan?: RuntimeEventPayload }
  | { event: 'plan_step_update'; plan_id?: string; step?: RuntimeEventPayload }
  | { event: 'plan_verification_start'; plan_id?: string; step_id?: string; command?: string }
  | { event: 'plan_verification_done'; plan_id?: string; step_id?: string; result?: RuntimeEventPayload }
  | { event: 'task_started'; task?: RuntimeEventPayload }
  | { event: 'task_progress'; task?: RuntimeEventPayload; progress?: RuntimeEventPayload }
  | { event: 'task_output'; task?: RuntimeEventPayload; offset?: number; chunk?: string }
  | { event: 'task_done'; task?: RuntimeEventPayload }
  | { event: 'task_error'; task?: RuntimeEventPayload; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeEventPayload; reason?: string }
  | { event: 'interaction_cancelled'; interaction?: RuntimeEventPayload; control?: RuntimeEventPayload }
  | { event: 'turn_paused'; interaction?: RuntimeEventPayload }
  | { event: 'subagent_start'; parent_id?: string; subagent_id?: string; agent_type?: string; purpose?: string }
  | { event: 'subagent_delta'; parent_id?: string; subagent_id?: string; agent_type?: string; delta?: string }
  | { event: 'subagent_tool_call'; parent_id?: string; subagent_id?: string; id?: string; name: string; arguments?: RuntimeEventPayload }
  | { event: 'subagent_tool_result'; parent_id?: string; subagent_id?: string; id?: string; name?: string; summary?: string }
  | { event: 'subagent_tool_error'; parent_id?: string; subagent_id?: string; id?: string; name?: string; message?: string }
  | { event: 'subagent_done'; parent_id?: string; subagent_id?: string; agent_type?: string; summary?: string }
  | { event: 'subagent_error'; parent_id?: string; subagent_id?: string; agent_type?: string; message?: string }
  | { event: 'team_member_update'; member?: RuntimeEventPayload }
  | { event: 'team_message'; message?: RuntimeEventPayload }
  | { event: 'team_run_start'; parent_id?: string; teammate?: string; role?: string; agent_type?: string; purpose?: string }
  | { event: 'team_run_delta'; parent_id?: string; teammate?: string; delta?: string }
  | { event: 'team_run_tool_call'; parent_id?: string; teammate?: string; id?: string; name: string; arguments?: RuntimeEventPayload }
  | { event: 'team_run_tool_result'; parent_id?: string; teammate?: string; id?: string; name?: string; summary?: string }
  | { event: 'team_run_tool_error'; parent_id?: string; teammate?: string; id?: string; name?: string; message?: string }
  | { event: 'team_run_done'; parent_id?: string; teammate?: string; summary?: string }
  | { event: 'team_run_error'; parent_id?: string; teammate?: string; message?: string }
  | { event: 'scheduler_job_update'; job?: RuntimeEventPayload; action?: string }
  | { event: 'scheduler_run_start'; job?: RuntimeEventPayload }
  | { event: 'scheduler_run_done'; job?: RuntimeEventPayload }
  | { event: 'scheduler_run_error'; job?: RuntimeEventPayload; error?: string }
  | { event: 'scheduler_run_cancelled'; job?: RuntimeEventPayload; reason?: string }
  | { event: 'runtime_task_cancelled'; task?: RuntimeEventPayload; reason?: string }
  | { event: 'record_degraded'; kind?: string; reason?: string; taskId?: string }
)
