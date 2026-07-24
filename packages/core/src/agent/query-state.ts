/**
 * query_state 恢复状态机 (MIG-CORE-007)。
 * 对齐 Python `agent/query_state/models.py` + `transitions.py`。
 * 空响应重试 / length 续写 / todo 续跑 / 暂停-完成 的状态转移；阈值与文案逐字保真。
 */

export enum TransitionReason {
  ITERATION = 'iteration',
  TOOL_FOLLOWUP = 'tool_followup',
  EMPTY_RESPONSE_RETRY = 'empty_response_retry',
  LENGTH_RECOVERY = 'length_recovery',
  TODO_CONTINUATION = 'todo_continuation',
  NEAR_MAX_TURNS = 'near_max_turns',
  PLAN_PAUSE = 'plan_pause',
  ASK_PAUSE = 'ask_pause',
  MAX_TURNS = 'max_turns',
  COMPLETED = 'completed',
}

export interface QueryState {
  turnId: string | null
  turnCount: number
  transition: string | null
  emptyRetries: number
  lengthRetries: number
  todoContinuations: number
  maxTurns: number | null
  paused: boolean
  completed: boolean
  finalWarningIssued: boolean
}

export function makeQueryState(p: Partial<QueryState> = {}): QueryState {
  return {
    turnId: p.turnId ?? null,
    turnCount: p.turnCount ?? 0,
    transition: p.transition ?? null,
    emptyRetries: p.emptyRetries ?? 0,
    lengthRetries: p.lengthRetries ?? 0,
    todoContinuations: p.todoContinuations ?? 0,
    maxTurns: p.maxTurns ?? null,
    paused: p.paused ?? false,
    completed: p.completed ?? false,
    finalWarningIssued: p.finalWarningIssued ?? false,
  }
}

export interface QueryTransition {
  reason: string
  nextState: QueryState
  messages: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  terminalReply: string | null
}

function transition(
  p: Partial<QueryTransition> & { reason: string; nextState: QueryState },
): QueryTransition {
  return {
    reason: p.reason,
    nextState: p.nextState,
    messages: p.messages ?? [],
    events: p.events ?? [],
    terminalReply: p.terminalReply ?? null,
  }
}

export function beginIteration(state: QueryState): QueryTransition {
  const nextState = {
    ...state,
    turnCount: state.turnCount + 1,
    transition: TransitionReason.ITERATION,
  }
  return transition({ reason: TransitionReason.ITERATION, nextState })
}

export function maxTurnsReached(state: QueryState): QueryTransition | null {
  if (state.maxTurns === null || state.turnCount < state.maxTurns) return null
  const reply = `（达到 max_turns=${state.maxTurns} 上限，未办妥；history 中已有部分进展）`
  const nextState = {
    ...state,
    transition: TransitionReason.MAX_TURNS,
    completed: true,
  }
  return transition({
    reason: TransitionReason.MAX_TURNS,
    nextState,
    terminalReply: reply,
  })
}

const NEAR_MAX_TURNS_RESERVE = 5

export function nearMaxTurns(state: QueryState): QueryTransition | null {
  if (state.maxTurns === null || state.maxTurns <= NEAR_MAX_TURNS_RESERVE)
    return null
  if (
    state.finalWarningIssued ||
    state.turnCount !== state.maxTurns - NEAR_MAX_TURNS_RESERVE
  )
    return null
  const content =
    '（接近回合上限，剩余轮次有限。请停止扩展新任务，收束当前工作，并在下一条回复输出最终交付报告：已完成事项、未完成事项、验证命令与结果、恢复入口。）'
  const nextState = {
    ...state,
    transition: TransitionReason.NEAR_MAX_TURNS,
    finalWarningIssued: true,
  }
  return transition({
    reason: TransitionReason.NEAR_MAX_TURNS,
    nextState,
    messages: [{ role: 'user', content }],
  })
}

export function toolFollowup(state: QueryState): QueryTransition {
  const nextState = {
    ...state,
    transition: TransitionReason.TOOL_FOLLOWUP,
    emptyRetries: 0,
    lengthRetries: 0,
  }
  return transition({ reason: TransitionReason.TOOL_FOLLOWUP, nextState })
}

export function emptyResponseRetry(
  state: QueryState,
  opts: { maxRetries: number },
): QueryTransition | null {
  if (state.emptyRetries >= opts.maxRetries) return null
  const attempt = state.emptyRetries + 1
  const nextState = {
    ...state,
    transition: TransitionReason.EMPTY_RESPONSE_RETRY,
    emptyRetries: attempt,
  }
  return transition({
    reason: TransitionReason.EMPTY_RESPONSE_RETRY,
    nextState,
    messages: [
      {
        role: 'user',
        content: '（上一轮无任何输出，请继续推进或给出最终答复）',
      },
    ],
    events: [
      {
        event: 'tool_error',
        name: '_empty_response',
        message: `empty response, retry ${attempt}/${opts.maxRetries}`,
      },
    ],
  })
}

export function lengthRecovery(
  state: QueryState,
  reply: string,
  opts: { maxRetries: number },
): QueryTransition | null {
  if (state.lengthRetries >= opts.maxRetries) return null
  const attempt = state.lengthRetries + 1
  const nextState = {
    ...state,
    transition: TransitionReason.LENGTH_RECOVERY,
    lengthRetries: attempt,
  }
  const messages: Array<Record<string, unknown>> = []
  if (reply) {
    const assistantMessage: Record<string, unknown> = {
      role: 'assistant',
      content: reply,
    }
    if (state.turnId) assistantMessage.turn_id = state.turnId
    messages.push(assistantMessage)
  }
  messages.push({
    role: 'user',
    content: '（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）',
  })
  return transition({
    reason: TransitionReason.LENGTH_RECOVERY,
    nextState,
    messages,
    events: [
      {
        event: 'tool_error',
        name: '_length_truncation',
        message: `truncated, continuing ${attempt}/${opts.maxRetries}`,
      },
    ],
  })
}

export function todoFollowup(
  state: QueryState,
  opts: {
    unfinishedText: string
    unfinishedCount: number
    maxContinuations?: number | null
  },
): QueryTransition | null {
  const maxContinuations =
    opts.maxContinuations === undefined ? 2 : opts.maxContinuations
  if (maxContinuations !== null && state.todoContinuations >= maxContinuations)
    return null
  const content =
    '差事尚未办妥，以下任务仍未完成，请按计划继续执行，并按规矩更新 todolist 状态：\n' +
    opts.unfinishedText
  const nextState = {
    ...state,
    transition: TransitionReason.TODO_CONTINUATION,
    todoContinuations: state.todoContinuations + 1,
  }
  return transition({
    reason: TransitionReason.TODO_CONTINUATION,
    nextState,
    messages: [{ role: 'user', content }],
    events: [],
  })
}

export type TodoContinuationIntent = 'explicit' | 'control' | 'none'

const EXPLICIT_TODO_CONTINUATION_RE =
  /^(?:\/continue(?:\s|$)|继续(?:执行)?(?:\s|[，,:：。!！]|$)|按原计划继续(?:\s|[，,:：。!！]|$))/i

export function isExplicitTodoContinuation(content: string): boolean {
  return EXPLICIT_TODO_CONTINUATION_RE.test(String(content ?? '').trim())
}

/**
 * Only the latest real user/control message may arm a previous todo list.
 * Old conversation text is deliberately ignored so a normal question cannot
 * inherit unfinished work from an earlier prompt.
 */
export function todoContinuationIntent(
  history: Array<Record<string, unknown>>,
): TodoContinuationIntent {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message?.role !== 'user') continue
    const content = String(message.content ?? '').trim()
    if (
      content.startsWith('[CONTROL:PLAN_APPROVED]') ||
      content.startsWith('[CONTROL:PERMISSION_ANSWERED]') ||
      content.startsWith('[CONTROL:GOAL_CONTINUATION_RESUMED]')
    )
      return 'control'
    return isExplicitTodoContinuation(content) ? 'explicit' : 'none'
  }
  return 'none'
}

export function markPaused(
  state: QueryState,
  reason: TransitionReason,
): QueryTransition {
  const nextState = { ...state, transition: reason, paused: true }
  return transition({ reason, nextState })
}

export function markCompleted(state: QueryState): QueryTransition {
  const nextState = {
    ...state,
    transition: TransitionReason.COMPLETED,
    completed: true,
  }
  return transition({ reason: TransitionReason.COMPLETED, nextState })
}
