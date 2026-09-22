/**
 * Session log → renderer runtime events.
 *
 * A pure, stateful fold: `apply(event)` returns the renderer events one log
 * event produces. Live streaming and bootstrap/replay run the same fold, so
 * the timeline is identical either way. Every emitted event carries
 * `seq = logSeq * 16 + k` (stable across live and replay, so the renderer's
 * seq de-duplication keeps working), `ts` (epoch ms), `session_id`, and
 * `turn_id = <sessionId>:<turn>` while a turn is open.
 */

import { messageText, type UserMessage } from '../../llm/message'
import type { SessionEvent, SessionEventMap } from '../../session-log/types'
import {
  answeredQuestionInteraction,
  approvalInteraction,
  decidedApprovalInteraction,
  questionInteraction,
  type InteractionPayload,
} from './interactions'
import '../subagent/manager'
import '../compaction/events'
import '../plan/plan-mode'
import '../sandbox/policy'
import '../approval/service'
import '../approval/presets'
import '../agent/inbox'
import '../agent/retry'
import '../agent/model-policy'
import '../questions/service'
import '../jobs/registry'
import '../hooks/types'
import { WorkflowRunFold, workflowTaskView } from '../workflow/records'
import {
  applyGoalEvent,
  emptyGoalFoldState,
  type GoalFoldState,
} from '../goal/fold'

export type UiEvent = Record<string, unknown> & {
  event: string
  seq: number
  ts: number
  session_id: string
}

declare module '../../session-log/types' {
  interface SessionEventMap {
    /**
     * Renderer-only facts about one user-authored message, logged by the host
     * before the message enters the inbox. Never model-visible.
     */
    'host/user-meta': {
      messageId: string
      clientMessageId?: string
      displayContent?: string
      attachments?: Array<Record<string, unknown>>
      source?: string
      scheduler?: Record<string, unknown>
      uiHidden?: boolean
    }
  }
}

/** Tools whose calls render as interaction cards rather than tool cards. */
export const INTERACTION_TOOLS: ReadonlySet<string> = new Set([
  'ask_user_question',
  'exit_plan_mode',
])
const SEQ_STRIDE = 16

export interface ProjectorOptions {
  sessionId: string
  /** Current control payload (preset/plan/approval/pending) for control_mode_update. */
  controlPayload?: () => Record<string, unknown>
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {}
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { raw }
  } catch {
    return { raw }
  }
}

export class SessionProjector {
  private turn: number | undefined
  private step = 0
  private readonly subagentParents = new Map<string, string | undefined>()
  private readonly userMeta = new Map<
    string,
    SessionEventMap['host/user-meta']
  >()
  private readonly toolNames = new Map<string, string>()
  private readonly toolArguments = new Map<string, Record<string, unknown>>()
  private readonly approvals = new Map<string, InteractionPayload>()
  private readonly questions = new Map<string, InteractionPayload>()
  private turnText = ''
  private contextWindow: number | undefined
  private model: string | undefined
  private provider: string | undefined
  private reasoning = new Map<number, string>()
  private readonly goal: GoalFoldState = emptyGoalFoldState()
  private readonly workflows = new WorkflowRunFold()

  constructor(private readonly options: ProjectorOptions) {}

  /** Project a whole log (bootstrap / replay). */
  static projectAll(
    events: readonly SessionEvent[],
    options: ProjectorOptions,
  ): UiEvent[] {
    const projector = new SessionProjector(options)
    return events.flatMap((event) => projector.apply(event))
  }

  private turnId(): string | undefined {
    return this.turn === undefined
      ? undefined
      : `${this.options.sessionId}:${this.turn}`
  }

  apply(event: SessionEvent): UiEvent[] {
    const out: UiEvent[] = []
    let k = 0
    const emit = (
      name: string,
      payload: Record<string, unknown> = {},
    ): void => {
      if (k >= SEQ_STRIDE) return
      const turnId = this.turnId()
      out.push({
        ...payload,
        event: name,
        seq: event.seq * SEQ_STRIDE + k + 1,
        ts: event.time,
        session_id: this.options.sessionId,
        ...(turnId === undefined || 'turn_id' in payload
          ? {}
          : { turn_id: turnId }),
      })
      k += 1
    }
    switch (event.type) {
      case 'host/user-meta':
        this.userMeta.set(event.data.messageId, event.data)
        break
      case 'turn/start':
        this.turn = event.data.turn
        this.step = 0
        this.turnText = ''
        emit('turn_phase', { phase: 'started' })
        break
      case 'step/start':
        this.step = event.data.step
        this.reasoning.clear()
        break
      case 'user/message': {
        // Admitted goal rounds advance `roundsStarted`; later goal changes are validated against it.
        const roundsBefore = this.goal.roundsStarted
        try {
          applyGoalEvent(this.goal, event)
        } catch {
          // a malformed goal fold never blocks message projection
        }
        this.projectUserMessage(event.data, emit)
        if (this.goal.roundsStarted !== roundsBefore)
          emit('goal_updated', { goal: this.goalView() })
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        const thoughtId = (index: number): string =>
          `${this.turnId() ?? 'turn'}:${this.step}:${index}`
        if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          this.turnText += chunk.text
          emit('message_delta', { delta: chunk.text })
        } else if (
          chunk.type === 'block-start' &&
          chunk.blockType === 'reasoning'
        ) {
          this.reasoning.set(chunk.index, '')
          emit('agent_thought', {
            thought_id: thoughtId(chunk.index),
            stage: 'reasoning',
            label: '思考',
            status: 'running',
            source: 'model',
          })
        } else if (chunk.type === 'reasoning-delta') {
          this.reasoning.set(
            chunk.index,
            (this.reasoning.get(chunk.index) ?? '') + chunk.text,
          )
        } else if (
          chunk.type === 'block-end' &&
          chunk.block.type === 'reasoning'
        ) {
          emit('agent_thought', {
            thought_id: thoughtId(chunk.index),
            stage: 'reasoning',
            label: '思考',
            status: 'done',
            source: 'model',
            summary: chunk.block.text,
          })
          this.reasoning.delete(chunk.index)
        }
        break
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (event.data.interrupted === true)
          emit('turn_phase', { phase: 'interrupted' })
        if (usage !== undefined) {
          emit('context_usage', {
            used:
              usage.inputTokens +
              (usage.cacheReadTokens ?? 0) +
              (usage.cacheWriteTokens ?? 0) +
              usage.outputTokens,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens ?? 0,
            ...(this.contextWindow === undefined
              ? {}
              : { max: this.contextWindow }),
            ...(this.model === undefined ? {} : { model: this.model }),
            ...(this.provider === undefined
              ? {}
              : { model_entry_id: this.provider }),
          })
        }
        break
      }
      case 'request/context':
        this.contextWindow = event.data.contextWindow
        this.model = event.data.model
        this.provider = event.data.provider
        break
      case 'tool/call': {
        const args = parseArguments(event.data.arguments)
        this.toolNames.set(event.data.callId, event.data.name)
        this.toolArguments.set(event.data.callId, args)
        if (INTERACTION_TOOLS.has(event.data.name)) break
        const common = {
          id: event.data.callId,
          name: event.data.name,
          tool_batch_id: `${this.turnId() ?? 'turn'}:${event.data.step}`,
        }
        emit('tool_call', { ...common, arguments: args })
        emit('tool_run_started', common)
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const name = this.toolNames.get(callId) ?? 'unknown_tool'
        if (INTERACTION_TOOLS.has(name)) break
        const block = event.data.message.content[0]
        const output = messageText({ content: block.content })
        const isError = block.isError === true
        const meta = event.data.meta
        const metadata =
          typeof meta === 'object' && meta !== null && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)
            : undefined
        const replaced =
          event.surfaceOp !== undefined && event.surfaceOp !== 'append'
        if (replaced) break
        emit('tool_result', {
          id: callId,
          name,
          output,
          is_error: isError,
          tool_batch_id: `${this.turnId() ?? 'turn'}:${event.data.step}`,
          ...(metadata === undefined ? {} : { metadata }),
          ...(name === 'todo_write' && Array.isArray(metadata?.todos)
            ? {
                todos: (metadata.todos as Array<Record<string, unknown>>).map(
                  (todo, index) => ({ id: String(index + 1), ...todo }),
                ),
              }
            : {}),
        })
        if (isError) {
          emit('tool_run_failed', {
            id: callId,
            name,
            message: output.replace(/^Error: /, '').slice(0, 2000),
            reason_kind:
              event.data.error?.code === 'FS_SANDBOX_DENIED' ||
              output.includes('[sandbox:')
                ? 'safety_refusal'
                : 'error',
            ...(metadata === undefined ? {} : { metadata }),
          })
        }
        break
      }
      case 'approval/asked': {
        const interaction = approvalInteraction(
          event.data,
          event.data.callId === undefined
            ? undefined
            : this.toolArguments.get(event.data.callId),
          event.time,
        )
        this.approvals.set(event.data.id, interaction)
        emit('ask_request', { interaction })
        break
      }
      case 'approval/decided': {
        const base = this.approvals.get(event.data.id)
        if (base === undefined) break
        const interaction = decidedApprovalInteraction(
          base,
          event.data.outcome,
          event.time,
        )
        this.approvals.set(event.data.id, interaction)
        emit(
          interaction.status === 'cancelled'
            ? 'interaction_cancelled'
            : 'ask_answered',
          { interaction },
        )
        break
      }
      case 'question/asked': {
        const interaction = questionInteraction(event.data, event.time)
        this.questions.set(event.data.id, interaction)
        emit(interaction.kind === 'plan' ? 'plan_draft' : 'ask_request', {
          interaction,
        })
        break
      }
      case 'question/answered': {
        const base = this.questions.get(event.data.id)
        if (base === undefined) break
        const answered = answeredQuestionInteraction(
          base,
          event.data,
          event.time,
        )
        this.questions.set(event.data.id, answered.interaction)
        const name =
          answered.outcome === 'cancelled'
            ? 'interaction_cancelled'
            : answered.outcome === 'approved'
              ? 'plan_approved'
              : answered.outcome === 'commented'
                ? 'plan_comment_added'
                : 'ask_answered'
        emit(name, {
          interaction: answered.interaction,
          ...(answered.comment === undefined
            ? {}
            : { comment: answered.comment }),
        })
        break
      }
      case 'plan/mode':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'permission/preset':
        if (this.options.controlPayload !== undefined)
          emit('control_mode_update', {
            control: this.options.controlPayload(),
          })
        break
      case 'compaction/start':
        emit('agent_thought', {
          thought_id: `compaction:${event.data.compactionId}`,
          stage: 'compaction',
          label: '压缩上下文',
          status: 'running',
          source: 'core',
        })
        break
      case 'compaction/end':
        emit('agent_thought', {
          thought_id: `compaction:${event.data.compactionId}`,
          stage: 'compaction',
          label: '压缩上下文',
          status: event.data.error === undefined ? 'done' : 'error',
          source: 'core',
          ...(event.data.error === undefined
            ? { summary: '已压缩较早的对话' }
            : { summary: event.data.error }),
        })
        break
      case 'llm/retry':
        emit('agent_thought', {
          thought_id: `retry:${event.data.retryId}`,
          stage: 'retry',
          label: '模型请求重试',
          status: 'running',
          source: 'core',
          summary: `${event.data.failure.message}（第 ${event.data.retry}${event.data.maxRetries === undefined ? '' : `/${event.data.maxRetries}`} 次，${Math.round(event.data.delayMs)}ms 后）`,
        })
        break
      case 'llm/retry-started':
        emit('agent_thought', {
          thought_id: `retry:${event.data.retryId}`,
          stage: 'retry',
          label: '模型请求重试',
          status: 'done',
          source: 'core',
        })
        break
      case 'llm/fallback':
        emit('agent_thought', {
          thought_id: `fallback:${event.data.fallbackId}`,
          stage: 'retry',
          label: '切换备用模型',
          status: 'done',
          source: 'core',
          summary: `${event.data.from} 请求失败（${event.data.failure.message}），本轮改用 ${event.data.to}`,
        })
        break
      case 'llm/cost-cap':
        emit('agent_thought', {
          thought_id: `cost-cap:${event.data.turn}`,
          stage: 'retry',
          label: '达到本轮成本上限',
          status: 'error',
          source: 'core',
          summary:
            event.data.unpricedRoutes === undefined
              ? `本轮已用 $${(event.data.spentUsdNanos / 1e9).toFixed(4)}，上限 $${(event.data.capUsdNanos / 1e9).toFixed(4)}，已停止`
              : `模型 ${event.data.unpricedRoutes.join(', ')} 缺少 pricing，无法执行成本上限，已停止`,
        })
        break
      case 'hook/invoked':
        emit('hook_run_started', {
          hook_id: event.data.handlerId,
          event_name: event.data.point,
          status: 'running',
        })
        break
      case 'hook/result':
        emit(
          event.data.decision === 'deny' || event.data.decision === 'block'
            ? 'hook_decision_applied'
            : 'hook_run_completed',
          {
            hook_id: event.data.handlerId,
            event_name: event.data.point,
            decision: event.data.decision,
            duration_ms: event.data.durationMs,
            status: 'completed',
          },
        )
        break
      case 'agent/inbox/spliced': {
        if (event.data.target !== 'next-step' || this.turn === undefined) break
        for (const message of event.data.inserted) {
          if (message.source.kind !== 'user') continue
          emit('prompt_interjected', {
            prompt_id: message.id,
            delivery: 'interject',
            target_turn_id: this.turnId() ?? null,
            content: messageText(message),
          })
        }
        break
      }
      case 'job/started':
        emit('task_started', {
          task: {
            id: event.data.jobId,
            kind: event.data.kind,
            label: event.data.description ?? event.data.command,
            command: event.data.command,
            status: 'running',
            session_id: this.options.sessionId,
          },
        })
        break
      case 'job/finished': {
        const task = {
          id: event.data.jobId,
          kind: event.data.kind,
          label: event.data.command,
          command: event.data.command,
          status: event.data.status,
          exit_code: event.data.exitCode ?? null,
          detail: event.data.detail ?? null,
          session_id: this.options.sessionId,
        }
        emit(
          event.data.status === 'completed'
            ? 'task_done'
            : event.data.status === 'killed'
              ? 'task_cancelled'
              : 'task_error',
          { task },
        )
        break
      }
      case 'goal/change':
      case 'goal/round': {
        try {
          applyGoalEvent(this.goal, event)
        } catch {
          break
        }
        emit('goal_updated', { goal: this.goalView() })
        break
      }
      case 'subagent/started':
        this.subagentParents.set(event.data.subagentId, event.data.callId)
        emit('subagent_start', {
          subagent_id: event.data.subagentId,
          purpose: event.data.description,
          mode: event.data.mode,
          background: event.data.background,
          ...(event.data.callId === undefined
            ? {}
            : { parent_id: event.data.callId }),
        })
        break
      case 'subagent/settled': {
        const parentId = this.subagentParents.get(event.data.subagentId)
        emit('subagent_done', {
          subagent_id: event.data.subagentId,
          summary: event.data.text ?? '',
          status: event.data.stopReason,
          ...(parentId === undefined ? {} : { parent_id: parentId }),
        })
        break
      }
      case 'tool-workflow/run-start':
      case 'tool-workflow/phase':
      case 'tool-workflow/log':
      case 'tool-workflow/agent-start':
      case 'tool-workflow/agent-end':
      case 'tool-workflow/run-end': {
        const record = this.workflows.apply(event)
        if (record === undefined) break
        const task = workflowTaskView(record, this.options.sessionId)
        if (event.type === 'tool-workflow/run-start')
          emit('workflow_started', { task })
        else if (event.type === 'tool-workflow/run-end')
          emit('workflow_finished', { task })
        else emit('workflow_progress', { task })
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'aborted') {
          emit('runtime_task_cancelled', { reason: reason.reason.kind })
        } else if (reason.kind === 'error') {
          emit('error', {
            message: reason.error.message,
            code: reason.error.code,
          })
        } else if (reason.kind === 'interrupted') {
          emit('runtime_task_cancelled', { reason: 'interrupted' })
        }
        emit('assistant_done', {
          content: this.turnText,
          stop_reason: reason.kind,
        })
        this.turn = undefined
        this.turnText = ''
        break
      }
      default:
        break
    }
    return out
  }

  /** Current goal snapshot for the UI (null when none). */
  goalView(): Record<string, unknown> | null {
    const goal = this.goal.goal
    if (goal === undefined) return null
    return {
      ...goal,
      roundsStarted: this.goal.roundsStarted,
      createdAt: this.goal.createdAt ?? 0,
      updatedAt: this.goal.updatedAt ?? 0,
    }
  }

  /** Latest interaction still waiting for an answer (approval/question/plan). */
  pendingInteraction(): InteractionPayload | null {
    let latest: InteractionPayload | null = null
    for (const interaction of [
      ...this.approvals.values(),
      ...this.questions.values(),
    ]) {
      if (interaction.status !== 'waiting') continue
      if (
        latest === null ||
        Number(interaction.created_at ?? 0) >= Number(latest.created_at ?? 0)
      )
        latest = interaction
    }
    return latest
  }

  private projectUserMessage(
    message: UserMessage,
    emit: (name: string, payload?: Record<string, unknown>) => void,
  ): void {
    const source = message.source
    if (source.kind === 'user') {
      const meta = this.userMeta.get(message.id)
      emit('user_message', {
        content: meta?.displayContent ?? messageText(message),
        message_id: message.id,
        ...(meta?.clientMessageId === undefined
          ? {}
          : { client_message_id: meta.clientMessageId }),
        ...(meta?.attachments === undefined
          ? {}
          : { attachments: meta.attachments }),
        ...(meta?.source === undefined ? {} : { source: meta.source }),
        ...(meta?.scheduler === undefined ? {} : { scheduler: meta.scheduler }),
        ...(meta?.uiHidden === true ? { ui_hidden: true } : {}),
      })
      return
    }
    if (source.kind !== 'context') return
    if (source.form === 'notice') {
      emit('agent_thought', {
        thought_id: `notice:${message.id}`,
        stage: 'notice',
        label: source.summary ?? '系统通知',
        summary: messageText(message),
        status: 'done',
        source: source.producer,
      })
    } else if (
      source.form === 'relay' &&
      source.producer === 'subagent-parent'
    ) {
      emit('user_message', {
        content: messageText(message),
        message_id: message.id,
        source: 'subagent-parent',
      })
    } else if (source.form === 'relay' && source.producer === 'subagent') {
      emit('user_message', {
        content: messageText(message),
        message_id: message.id,
        source: 'subagent',
      })
    }
  }
}
