/**
 * Renderer runtime event union.
 *
 * Mirrors the payloads the session projector
 * (`harness/projection/projector.ts` + `interactions.ts`) and the host
 * (`HarnessHost.emitHost` and the kept services) put on the wire. The event
 * names are pinned to `RUNTIME_EVENT_NAMES` in `wire-discriminant.ts`.
 *
 * Browser-safe: type-only, no imports from kernel modules.
 */

export type RuntimeEventPayload = Record<string, unknown>

export interface RuntimeEventEnvelope {
  /** `logSeq * 16 + k` for projector events; `0` for host-only events. */
  seq?: number
  /** Epoch milliseconds. */
  ts?: number
  session_id?: string
  /** `<sessionId>:<turn>` while a turn is open. */
  turn_id?: string
  client_message_id?: string
  source?: string
}

/** Current goal snapshot (`GoalView` without a hard kernel dependency). */
export interface RuntimeGoalView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete' | string
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  /** Present only on live host views. */
  activation?: 'armed' | 'disarmed' | string
}

export interface HookRuntimeEventFields {
  hook_id?: string
  event_name?: string
  status?: string
  decision?: string
  duration_ms?: number
}

export interface EnvironmentRuntimeEventFields {
  job_id?: string
  tool_id?: string | null
  step_id?: string | null
  status?: string
  completed_steps?: number
  total_steps?: number
  error_code?: string | null
  install_source?: 'skill' | 'url' | 'catalog' | string | null
  placement?: 'managed' | 'external' | string | null
  recipe_trust?: string | null
  catalog_revision?: string
  project_fingerprint?: string
}

export interface SubagentRuntimeEventFields {
  /** Parent tool call (`subagent` / `subagent_fork`) that spawned the child. */
  parent_id?: string
  subagent_id?: string
  agent_type?: string
}

export interface SchedulerRunEventFields {
  job?: RuntimeEventPayload
  run?: RuntimeEventPayload
  run_id?: string
  task_id?: string
}

export type RuntimeEvent = RuntimeEventEnvelope &
  (
    | {
        event: 'user_message'
        content?: string
        message_id?: string
        attachments?: RuntimeEventPayload[]
        scheduler?: RuntimeEventPayload
        ui_hidden?: boolean
      }
    | {
        event: 'prompt_interjected'
        prompt_id: string
        delivery?: 'interject'
        target_turn_id?: string | null
        content?: string
      }
    | { event: 'message_delta'; delta?: string }
    | {
        event: 'agent_thought'
        /** Stable id: running/done updates of one thought share it. */
        thought_id: string
        stage?: 'reasoning' | 'compaction' | 'retry' | 'notice' | string
        label?: string
        summary?: string
        source?: string
        status?: 'running' | 'done' | 'error' | string
      }
    | {
        event: 'turn_phase'
        phase?: 'started' | 'interrupted' | string
      }
    | {
        event: 'context_usage'
        used?: number
        max?: number
        input_tokens?: number
        output_tokens?: number
        cache_read_tokens?: number
        model?: string
        model_entry_id?: string
      }
    | {
        event: 'tool_call'
        id: string
        name: string
        arguments?: RuntimeEventPayload
        tool_batch_id?: string
      }
    | {
        event: 'tool_run_started'
        id: string
        name: string
        tool_batch_id?: string
      }
    | {
        event: 'tool_result'
        id: string
        name: string
        output?: string
        is_error?: boolean
        metadata?: RuntimeEventPayload
        todos?: RuntimeEventPayload[]
        tool_batch_id?: string
      }
    | {
        event: 'tool_run_failed'
        id: string
        name: string
        message?: string
        reason_kind?: 'safety_refusal' | 'error' | string
        metadata?: RuntimeEventPayload
      }
    | { event: 'ask_request'; interaction?: RuntimeEventPayload }
    | { event: 'ask_answered'; interaction?: RuntimeEventPayload }
    | { event: 'plan_draft'; interaction?: RuntimeEventPayload }
    | { event: 'plan_approved'; interaction?: RuntimeEventPayload }
    | {
        event: 'plan_comment_added'
        interaction?: RuntimeEventPayload
        comment?: string
      }
    | { event: 'interaction_cancelled'; interaction?: RuntimeEventPayload }
    | { event: 'control_mode_update'; control?: RuntimeEventPayload }
    | (HookRuntimeEventFields & { event: 'hook_run_started' })
    | (HookRuntimeEventFields & { event: 'hook_run_completed' })
    | (HookRuntimeEventFields & { event: 'hook_decision_applied' })
    | { event: 'goal_updated'; goal: RuntimeGoalView | null }
    | { event: 'task_started'; task?: RuntimeEventPayload }
    | { event: 'task_done'; task?: RuntimeEventPayload }
    | { event: 'task_error'; task?: RuntimeEventPayload }
    | { event: 'task_cancelled'; task?: RuntimeEventPayload }
    | { event: 'workflow_started'; task?: RuntimeEventPayload }
    | { event: 'workflow_progress'; task?: RuntimeEventPayload }
    | { event: 'workflow_finished'; task?: RuntimeEventPayload }
    | { event: 'runtime_task_cancelled'; reason?: string }
    | { event: 'error'; message?: string; code?: string }
    | { event: 'assistant_done'; content?: string; stop_reason?: string }
    | (SubagentRuntimeEventFields & {
        event: 'subagent_start'
        purpose?: string
      })
    | (SubagentRuntimeEventFields & { event: 'subagent_delta'; delta?: string })
    | (SubagentRuntimeEventFields & {
        event: 'subagent_tool_call'
        id?: string
        name: string
        arguments?: RuntimeEventPayload
      })
    | (SubagentRuntimeEventFields & {
        event: 'subagent_tool_result'
        id?: string
        name?: string
        summary?: string
      })
    | (SubagentRuntimeEventFields & {
        event: 'subagent_tool_error'
        id?: string
        name?: string
        message?: string
      })
    | (SubagentRuntimeEventFields & {
        event: 'subagent_done'
        summary?: string
        status?: string
      })
    | (SubagentRuntimeEventFields & {
        event: 'subagent_error'
        message?: string
      })
    | {
        event: 'session_created'
        session?: RuntimeEventPayload
        client_draft_id?: string | null
      }
    | { event: 'session_title_updated'; session?: RuntimeEventPayload }
    | {
        /** A user prompt entered the session's inbox (host-only; refresh the queue). */
        event: 'prompt_queued'
        prompt_id: string
      }
    | {
        /** A queued user prompt left the inbox: started, cancelled, or discarded. */
        event: 'prompt_dequeued'
        prompt_id: string
      }
    | {
        event: 'profile_onboarding_status_changed'
        profile_onboarding?: RuntimeEventPayload
        reason?: string
      }
    | {
        event: 'mcp_connection_state'
        server_name: string
        transport?: string
        generation: number
        client_id?: string | null
        state: string
        health?: string
        auth?: string
        tool_count?: number
        tools?: string[]
        restart_attempts?: number
        next_retry_at?: number | null
        active_request_count?: number
        active_request_ids?: string[]
        last_error?: RuntimeEventPayload | null
      }
    | { event: 'skill_catalog_changed'; catalog_version?: number }
    | (EnvironmentRuntimeEventFields & {
        event: 'environment_install_started'
      })
    | (EnvironmentRuntimeEventFields & {
        event: 'environment_install_progress'
      })
    | (EnvironmentRuntimeEventFields & {
        event: 'environment_install_completed'
      })
    | (EnvironmentRuntimeEventFields & {
        event: 'environment_install_failed'
      })
    | (EnvironmentRuntimeEventFields & { event: 'environment_changed' })
    | {
        event: 'git_operation_completed'
        action:
          | 'commit'
          | 'push'
          | 'pull'
          | 'switch_branch'
          | 'create_worktree'
          | 'remove_worktree'
          | 'publish_pr'
          | 'merge_pr'
          | 'close_pr'
        branch?: string
        commitOid?: string
        remoteHost?: string
        pullRequest?: {
          number: number
          url: string
          state: string
        }
        completedAt: number
      }
    | (SchedulerRunEventFields & {
        event: 'scheduler_run_start' | 'scheduler_run_done'
      })
    | (SchedulerRunEventFields & {
        event: 'scheduler_run_error'
        error?: string
      })
    | (SchedulerRunEventFields & {
        event:
          | 'scheduler_run_cancelled'
          | 'scheduler_run_skipped'
          | 'scheduler_run_interrupted'
        reason?: string
      })
  )
