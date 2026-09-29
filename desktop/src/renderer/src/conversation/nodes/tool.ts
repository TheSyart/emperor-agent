// Tool call Definition: tool/call (running) → tool/result (settled), with
// the interactions the call owns attached through links: background jobs
// (`job/finished`), delegated subagents (`subagent/*`), workflow / ralph
// runs (`tool-workflow/*`), approval escalations (`approval/*`), Computer
// Use grant cards (`ui/grant-*`) and ask_user_question (`question/*`).
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationLink,
  ConversationMatch,
  ConversationNodeContext,
} from '../assembler'
import { isAppendSurfaceEvent, isEvent } from '../events'
import type {
  ToolApprovalView,
  ToolChatData,
  ToolGrantView,
  ToolJobView,
  ToolQuestionView,
  ToolResultView,
  ToolSubagentView,
} from '../types'
import {
  chatNode,
  closedBoundary,
  contextLocation,
  stepOf,
  turnOf,
} from './common'
import { foldWorkflow, isWorkflowEvent, workflowRunId } from './workflow'

interface ToolCallFacts {
  readonly callId: string
  readonly name: string
  readonly argsRaw: string
  readonly argsTruncated: boolean
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly seq: number
}

interface ToolState {
  readonly call: ToolCallFacts | undefined
  readonly result: ToolResultView | undefined
  readonly job: ToolJobView | undefined
  readonly subagent: ToolSubagentView | undefined
  readonly workflow: ReturnType<typeof foldWorkflow>
  readonly approvals: readonly ToolApprovalView[]
  readonly grants: readonly ToolGrantView[]
  readonly question: ToolQuestionView | undefined
}

const EMPTY_STATE: ToolState = {
  call: undefined,
  result: undefined,
  job: undefined,
  subagent: undefined,
  workflow: undefined,
  approvals: [],
  grants: [],
  question: undefined,
}

function resultCallId(event: WireSessionEvent): string | undefined {
  if (!isEvent(event, 'tool/result') || !isAppendSurfaceEvent(event))
    return undefined
  return String(event.data.message.source.callId)
}

function backgroundJobId(event: WireSessionEvent): string | undefined {
  if (!isEvent(event, 'tool/result')) return undefined
  const meta = event.data.meta as { kind?: unknown; jobId?: unknown } | null
  if (typeof meta !== 'object' || meta === null) return undefined
  return meta.kind === 'background' && typeof meta.jobId === 'string'
    ? meta.jobId
    : undefined
}

function applyMatch(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (isEvent(event, 'tool/call')) {
    return {
      ...state,
      call: {
        callId: String(event.data.callId),
        name: event.data.name,
        argsRaw: event.data.arguments,
        argsTruncated: event.wire?.field === 'arguments',
        turn: event.data.turn,
        step: event.data.step,
        time: event.time,
        seq: event.seq,
      },
    }
  }
  if (isEvent(event, 'tool/result')) {
    const block = event.data.message.content[0]
    const jobId = backgroundJobId(event)
    return {
      ...state,
      result: {
        seq: event.seq,
        time: event.time,
        content: block.content,
        isError: block.isError === true,
        ...(event.data.error === undefined ? {} : { error: event.data.error }),
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        ...(event.wire?.field === 'result' ? { truncated: true } : {}),
      },
      ...(jobId === undefined || state.job?.jobId === jobId
        ? {}
        : { job: { jobId, status: 'running' } }),
    }
  }
  if (isEvent(event, 'job/finished')) {
    return {
      ...state,
      job: {
        jobId: event.data.jobId,
        status: event.data.status,
        ...(event.data.exitCode === undefined
          ? {}
          : { exitCode: event.data.exitCode }),
        ...(event.data.detail === undefined
          ? {}
          : { detail: event.data.detail }),
      },
    }
  }
  if (isEvent(event, 'subagent/started')) {
    const data = event.data
    return {
      ...state,
      subagent: {
        subagentId: data.subagentId,
        description: data.description,
        mode: data.mode,
        background: data.background,
        status: 'running',
      },
    }
  }
  if (isEvent(event, 'subagent/settled')) {
    const previous = state.subagent
    if (previous === undefined) return state
    return {
      ...state,
      subagent: {
        ...previous,
        status: 'settled',
        stopReason: event.data.stopReason,
        ...(event.data.text === undefined ? {} : { text: event.data.text }),
      },
    }
  }
  if (isWorkflowEvent(event)) {
    return { ...state, workflow: foldWorkflow(state.workflow, event) }
  }
  if (isEvent(event, 'approval/asked')) {
    return {
      ...state,
      approvals: [
        ...state.approvals,
        {
          id: event.data.id,
          toolName: event.data.toolName,
          ...(event.data.reason === undefined
            ? {}
            : { reason: event.data.reason }),
        },
      ],
    }
  }
  if (isEvent(event, 'approval/decided')) {
    const id = event.data.id
    return {
      ...state,
      approvals: state.approvals.map((approval) =>
        approval.id === id
          ? { ...approval, outcome: event.data.outcome }
          : approval,
      ),
    }
  }
  if (isEvent(event, 'ui/grant-requested')) {
    const data = event.data
    const scope = data.targetScope
    const target =
      data.display?.url ??
      (scope.kind === 'browser'
        ? scope.origins.join(' ')
        : (data.display?.appName ?? scope.appId))
    return {
      ...state,
      grants: [
        ...state.grants,
        {
          id: data.requestId,
          actions: data.actions,
          target,
          ...(data.highImpact === true ? { highImpact: true } : {}),
        },
      ],
    }
  }
  if (isEvent(event, 'ui/grant-decided')) {
    const data = event.data
    return {
      ...state,
      grants: state.grants.map((grant) =>
        grant.id === data.requestId
          ? {
              ...grant,
              decision: data.decision,
              ...(data.cause === undefined ? {} : { cause: data.cause }),
            }
          : grant,
      ),
    }
  }
  if (isEvent(event, 'question/asked')) {
    const data = event.data
    return {
      ...state,
      question: {
        id: data.id,
        questions: data.questions,
        ...(data.intent === undefined ? {} : { intent: data.intent }),
      },
    }
  }
  if (isEvent(event, 'question/answered')) {
    const previous = state.question
    if (previous === undefined || previous.id !== event.data.id) return state
    const data = event.data
    return {
      ...state,
      question:
        'answers' in data
          ? { ...previous, answers: data.answers, outcome: 'answered' }
          : { ...previous, outcome: data.outcome },
    }
  }
  return state
}

function fold(context: ConversationNodeContext<ToolState>): ToolState {
  let state = EMPTY_STATE
  for (const match of context.matches) state = applyMatch(state, match)
  return state
}

export const toolDefinition: ConversationDefinition<ToolState> = {
  kind: 'tool',
  target: 'chat',
  links: (event) => {
    const links: ConversationLink[] = []
    const callId = resultCallId(event)
    const jobId = backgroundJobId(event)
    if (callId !== undefined && jobId !== undefined)
      links.push({ ns: 'job', key: jobId, id: callId })
    if (isEvent(event, 'subagent/started') && event.data.callId !== undefined)
      links.push({
        ns: 'subagent',
        key: event.data.subagentId,
        id: event.data.callId,
      })
    if (
      isEvent(event, 'tool-workflow/run-start') &&
      event.data.callId !== undefined
    )
      links.push({
        ns: 'workflow',
        key: event.data.runId,
        id: event.data.callId,
      })
    if (isEvent(event, 'approval/asked') && event.data.callId !== undefined)
      links.push({ ns: 'approval', key: event.data.id, id: event.data.callId })
    if (isEvent(event, 'question/asked') && event.data.callId !== undefined)
      links.push({ ns: 'question', key: event.data.id, id: event.data.callId })
    if (isEvent(event, 'ui/grant-requested') && event.data.callId !== undefined)
      links.push({
        ns: 'grant',
        key: event.data.requestId,
        id: event.data.callId,
      })
    return links
  },
  match: (event) => {
    if (isEvent(event, 'tool/call'))
      return { id: String(event.data.callId), role: 'start' }
    const callId = resultCallId(event)
    if (callId !== undefined) return { id: callId, role: 'update' }
    if (isEvent(event, 'job/finished'))
      return { via: { ns: 'job', key: event.data.jobId }, role: 'update' }
    if (isEvent(event, 'subagent/started'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    if (isEvent(event, 'subagent/settled'))
      return {
        via: { ns: 'subagent', key: event.data.subagentId },
        role: 'update',
      }
    if (isEvent(event, 'tool-workflow/run-start'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    const runId = workflowRunId(event)
    if (runId !== undefined)
      return { via: { ns: 'workflow', key: runId }, role: 'update' }
    if (isEvent(event, 'approval/asked') || isEvent(event, 'question/asked'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    if (isEvent(event, 'ui/grant-requested'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    if (isEvent(event, 'ui/grant-decided'))
      return {
        via: { ns: 'grant', key: event.data.requestId },
        role: 'update',
      }
    if (isEvent(event, 'approval/decided'))
      return { via: { ns: 'approval', key: event.data.id }, role: 'update' }
    if (isEvent(event, 'question/answered'))
      return { via: { ns: 'question', key: event.data.id }, role: 'update' }
    return null
  },
  start: (_context, match) => applyMatch(EMPTY_STATE, match),
  update: (context, match) => applyMatch(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? fold(context)
    const result = state.result
    const call = state.call
    if (call === undefined && result === undefined) return null
    const location = contextLocation(context)
    const turn = call?.turn ?? turnOf(location)?.turn ?? 0
    const step = call?.step ?? stepOf(location)?.step ?? 0
    const interrupted =
      result === undefined &&
      closedBoundary(context.start?.location) !== undefined
    const data: ToolChatData = {
      callId: call?.callId ?? context.id,
      name: call?.name ?? '',
      argsRaw: call?.argsRaw ?? '',
      turn,
      step,
      time: call?.time ?? result?.time ?? 0,
      status:
        result !== undefined
          ? 'settled'
          : interrupted
            ? 'interrupted'
            : 'running',
      approvals: state.approvals,
      ...(state.grants.length === 0 ? {} : { grants: state.grants }),
      ...(call?.argsTruncated === true ? { argsTruncated: true } : {}),
      ...(result === undefined ? {} : { result }),
      ...(state.job === undefined ? {} : { job: state.job }),
      ...(state.subagent === undefined ? {} : { subagent: state.subagent }),
      ...(state.workflow === undefined
        ? {}
        : { workflow: state.workflow.view }),
      ...(state.question === undefined ? {} : { question: state.question }),
    }
    const anchor =
      call?.seq ?? result?.seq ?? context.matches[0]?.event.seq ?? 0
    return chatNode(context, 'tool', anchor, data)
  },
}
