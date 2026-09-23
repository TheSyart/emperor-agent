import {
  RUNTIME_EVENT_NAMES,
  type RuntimeEventName,
} from '@emperor/core/runtime-contract'
import type { WsEvent } from '../types'
import { isGoalRuntimeEvent } from './events'
import { isTaskRuntimeEvent } from './taskProjection'

/**
 * Projectors of the UiEvent pipeline. The chat transcript is not one of them:
 * it renders from the raw session log (conversation/*).
 */
export type RuntimeProjectorKind = 'session' | 'goal' | 'task' | 'feature'

export type RuntimeLiveEffectKind =
  'present' | 'refresh_memory' | 'refresh_skills'

export interface RuntimeEventDescriptor {
  readonly event: string
  readonly projectors: readonly RuntimeProjectorKind[]
  readonly liveEffects: readonly RuntimeLiveEffectKind[]
}

const PRESENTATION_EVENTS = new Set<string>([
  'ask_answered',
  'ask_request',
  'assistant_done',
  'context_usage',
  'control_mode_update',
  'error',
  'git_operation_completed',
  'goal_updated',
  'hook_decision_applied',
  'hook_run_started',
  'interaction_cancelled',
  'plan_approved',
  'plan_comment_added',
  'plan_draft',
  'profile_onboarding_status_changed',
  'prompt_interjected',
  'runtime_task_cancelled',
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
  'task_cancelled',
  'task_done',
  'task_error',
  'task_started',
  'tool_result',
  'tool_run_failed',
  'user_message',
])

function descriptorFor(event: RuntimeEventName): RuntimeEventDescriptor {
  const projectors: RuntimeProjectorKind[] = ['session']
  if (isGoalRuntimeEvent({ event } as WsEvent)) projectors.push('goal')
  if (isTaskRuntimeEvent({ event } as WsEvent)) projectors.push('task')
  if (projectors.length === 1) projectors.push('feature')

  const liveEffects: RuntimeLiveEffectKind[] = []
  if (PRESENTATION_EVENTS.has(event)) liveEffects.push('present')
  if (event === 'assistant_done') liveEffects.push('refresh_memory')
  if (event === 'skill_catalog_changed') liveEffects.push('refresh_skills')
  return { event, projectors, liveEffects }
}

export const RUNTIME_EVENT_DISPATCHERS = Object.fromEntries(
  RUNTIME_EVENT_NAMES.map((event) => [event, descriptorFor(event)]),
) as Readonly<Record<RuntimeEventName, RuntimeEventDescriptor>>

export function runtimeEventDescriptor(
  event: string,
): RuntimeEventDescriptor | null {
  return RUNTIME_EVENT_DISPATCHERS[event as RuntimeEventName] ?? null
}
