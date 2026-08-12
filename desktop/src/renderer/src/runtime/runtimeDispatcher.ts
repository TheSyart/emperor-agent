import {
  RUNTIME_EVENT_NAMES,
  type RuntimeEventName,
} from '@emperor/core/runtime-contract'
import type { WsEvent } from '../types'
import { isChatProjectionEvent } from './chatProjection'
import { isGoalRuntimeEvent } from './events'
import { isTaskRuntimeEvent } from './taskProjection'

export type RuntimeProjectorKind =
  'session' | 'chat' | 'plan' | 'goal' | 'task' | 'turn_change' | 'feature'

export type RuntimeLiveEffectKind = 'present' | 'refresh_memory'

export interface RuntimeEventDescriptor {
  readonly event: string
  readonly projectors: readonly RuntimeProjectorKind[]
  readonly liveEffects: readonly RuntimeLiveEffectKind[]
}

const PLAN_EVENTS = new Set<string>([
  'plan_approved',
  'plan_entry_decision',
  'plan_runtime_update',
  'plan_step_update',
  'plan_verification_start',
  'plan_verification_done',
])

const PRESENTATION_EVENTS = new Set<string>([
  'ask_answered',
  'ask_request',
  'assistant_done',
  'context_usage',
  'control_mode_update',
  'error',
  'hook_run_failed',
  'hook_run_progress',
  'hook_run_started',
  'interaction_cancelled',
  'model_route_fallback',
  'plan_approved',
  'plan_comment_added',
  'plan_draft',
  'profile_onboarding_status_changed',
  'prompt_cancelled',
  'prompt_dequeued',
  'prompt_interjected',
  'prompt_queued',
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
  'session_created',
  'session_title_updated',
  'subagent_delta',
  'subagent_done',
  'subagent_error',
  'subagent_start',
  'subagent_tool_call',
  'subagent_tool_error',
  'subagent_tool_result',
  'team_member_update',
  'team_message',
  'team_run_delta',
  'team_run_done',
  'team_run_error',
  'team_run_start',
  'team_run_tool_call',
  'team_run_tool_error',
  'team_run_tool_result',
  'tool_error',
  'tool_result',
  'turn_paused',
  'user_message',
])

function descriptorFor(event: RuntimeEventName): RuntimeEventDescriptor {
  const projectors: RuntimeProjectorKind[] = ['session']
  if (isChatProjectionEvent({ event })) projectors.push('chat')
  if (PLAN_EVENTS.has(event)) projectors.push('plan')
  if (isGoalRuntimeEvent({ event } as WsEvent)) projectors.push('goal')
  if (isTaskRuntimeEvent({ event } as WsEvent)) projectors.push('task')
  if (event === 'turn_change_snapshot') projectors.push('turn_change')
  if (projectors.length === 1) projectors.push('feature')

  const liveEffects: RuntimeLiveEffectKind[] = []
  if (PRESENTATION_EVENTS.has(event)) liveEffects.push('present')
  if (event === 'assistant_done') liveEffects.push('refresh_memory')
  return { event, projectors, liveEffects }
}

export const RUNTIME_EVENT_DISPATCHERS = Object.fromEntries(
  RUNTIME_EVENT_NAMES.map((event) => [event, descriptorFor(event)]),
) as Readonly<Record<RuntimeEventName, RuntimeEventDescriptor>>

const LEGACY_RUNTIME_DESCRIPTOR: RuntimeEventDescriptor = {
  event: 'historical_runtime_activity',
  projectors: ['session', 'chat'],
  liveEffects: [],
}

export function runtimeEventDescriptor(
  event: string,
): RuntimeEventDescriptor | null {
  if (event === 'historical_runtime_activity') return LEGACY_RUNTIME_DESCRIPTOR
  return RUNTIME_EVENT_DISPATCHERS[event as RuntimeEventName] ?? null
}
