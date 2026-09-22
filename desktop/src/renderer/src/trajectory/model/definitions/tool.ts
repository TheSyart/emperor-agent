// Trajectory-owned tool lifecycle (ported from the dsh
// trajectory-tool-definition). Emperor has no Code Dispatch; instead the
// root call is enriched through links:
// - `subagent/started|settled` → the delegated child session and status;
// - `job/started|finished` (linked by the background result's jobId) → one
//   subtool record per background job;
// - `tool-workflow/*` (linked by runId) → one subtool record per workflow
//   member (child session), with the run facts on the root.
// Workflow runs without a calling tool become standalone root records.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationLink,
  ConversationMatch,
  ConversationNodeContext,
} from '../../../conversation/assembler'
import { isAppendSurfaceEvent, isEvent } from '../../../conversation/events'
import { workflowRunId } from '../../../conversation/nodes/workflow'
import type {
  TrajectoryJobFact,
  TrajectoryRunningCall,
  TrajectorySubagentFact,
  TrajectoryToolCallBlock,
  TrajectoryToolResultNode,
  TrajectoryWorkflowFact,
} from '../contract'
import {
  closedBoundaryOf,
  matchCoordinates,
  textContent,
  trajectoryNode,
} from './common'

/** Narration lines kept per workflow run. */
const MAX_WORKFLOW_LOGS = 50

interface ToolState {
  readonly rootId: string
  readonly calls: ReadonlyMap<string, TrajectoryToolCallBlock>
  /** Child call ids in start order. */
  readonly children: readonly string[]
  readonly subagent: TrajectorySubagentFact | undefined
  readonly job: TrajectoryJobFact | undefined
  readonly workflow: TrajectoryWorkflowFact | undefined
}

function emptyState(rootId: string): ToolState {
  return {
    rootId,
    calls: new Map(),
    children: [],
    subagent: undefined,
    job: undefined,
    workflow: undefined,
  }
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

function rootCall(match: ConversationMatch): TrajectoryRunningCall {
  const event = match.event
  if (!isEvent(event, 'tool/call'))
    throw new Error('trajectory-tool-call start requires tool/call')
  return {
    callId: String(event.data.callId),
    name: event.data.name,
    argsRaw: event.data.arguments,
    ...(event.wire?.field === 'arguments' ? { argsTruncated: true } : {}),
    callSeq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    time: event.time,
    subCalls: [],
  }
}

function rootResult(
  match: ConversationMatch,
  previous: TrajectoryRunningCall | undefined,
): TrajectoryToolResultNode | undefined {
  const event = match.event
  if (!isEvent(event, 'tool/result')) return undefined
  const block = event.data.message.content[0]
  return {
    kind: 'tool-result',
    seq: event.seq,
    time: event.time,
    callId: String(event.data.message.source.callId),
    call:
      previous === undefined
        ? null
        : { name: previous.name, argsRaw: previous.argsRaw },
    callTime: previous?.time ?? null,
    content: block.content,
    isError: block.isError === true,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
    ...(event.wire?.field === 'result' ? { truncated: true } : {}),
    ...(previous?.argsTruncated === true ? { argsTruncated: true } : {}),
    ...(previous?.callSeq === undefined ? {} : { callSeq: previous.callSeq }),
    subCalls: [],
  }
}

function withChild(
  state: ToolState,
  id: string,
  block: TrajectoryToolCallBlock,
): ToolState {
  const calls = new Map(state.calls)
  calls.set(id, block)
  return {
    ...state,
    calls,
    children: state.children.includes(id)
      ? state.children
      : [...state.children, id],
  }
}

function jobCallId(jobId: string): string {
  return `job:${jobId}`
}

function memberCallId(runId: string, seq: number): string {
  return `workflow:${runId}:${seq}`
}

function settledChild(
  match: ConversationMatch,
  previous: TrajectoryToolCallBlock | undefined,
  fallback: { callId: string; name: string; argsRaw: string },
  text: string,
  isError: boolean,
): TrajectoryToolResultNode {
  const running =
    previous !== undefined && !('kind' in previous) ? previous : undefined
  return {
    kind: 'tool-result',
    seq: match.event.seq,
    time: match.event.time,
    callId: fallback.callId,
    call: {
      name: running?.name ?? fallback.name,
      argsRaw: running?.argsRaw ?? fallback.argsRaw,
    },
    callTime: running?.time ?? null,
    content: textContent(text),
    isError,
    ...(previous?.childSessionId === undefined
      ? {}
      : { childSessionId: previous.childSessionId }),
    subCalls: [],
  }
}

function applyWorkflow(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (isEvent(event, 'tool-workflow/run-start')) {
    const data = event.data
    return {
      ...state,
      workflow: {
        runId: data.runId,
        name: data.name,
        status: 'running',
        phases: [],
        logs: [],
        ...(data.tool === undefined ? {} : { tool: data.tool }),
      },
    }
  }
  const workflow = state.workflow
  if (workflow === undefined) return state
  if (isEvent(event, 'tool-workflow/phase')) {
    return workflow.phases.includes(event.data.title)
      ? state
      : {
          ...state,
          workflow: {
            ...workflow,
            phases: [...workflow.phases, event.data.title],
          },
        }
  }
  if (isEvent(event, 'tool-workflow/log')) {
    return {
      ...state,
      workflow: {
        ...workflow,
        logs: [...workflow.logs, event.data.message].slice(-MAX_WORKFLOW_LOGS),
      },
    }
  }
  if (isEvent(event, 'tool-workflow/agent-start')) {
    const data = event.data
    const { turn, step } = matchCoordinates(match)
    const callId = memberCallId(data.runId, data.seq)
    const phase = data.phase ?? workflow.phases.at(-1)
    return withChild(state, callId, {
      callId,
      name: data.label,
      argsRaw: JSON.stringify({
        childId: data.childId,
        ...(phase === undefined ? {} : { phase }),
      }),
      turn,
      step,
      time: event.time,
      childSessionId: data.childId,
      subCalls: [],
    })
  }
  if (isEvent(event, 'tool-workflow/agent-end')) {
    const data = event.data
    const callId = memberCallId(data.runId, data.seq)
    const previous = state.calls.get(callId)
    return withChild(
      state,
      callId,
      settledChild(
        match,
        previous,
        { callId, name: `member ${data.seq}`, argsRaw: '' },
        data.outcome,
        data.outcome !== 'completed',
      ),
    )
  }
  if (isEvent(event, 'tool-workflow/run-end')) {
    const data = event.data
    return {
      ...state,
      workflow: {
        ...workflow,
        status: data.stopReason,
        ...(data.error === undefined ? {} : { error: data.error }),
        ...(data.result === undefined ? {} : { result: data.result }),
      },
    }
  }
  return state
}

function applyMatch(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (isEvent(event, 'tool/call')) {
    const calls = new Map(state.calls)
    calls.set(state.rootId, rootCall(match))
    return { ...state, calls }
  }
  if (isEvent(event, 'tool/result')) {
    const previous = state.calls.get(state.rootId)
    const running =
      previous !== undefined && !('kind' in previous) ? previous : undefined
    const result = rootResult(match, running)
    if (result === undefined) return state
    const calls = new Map(state.calls)
    calls.set(state.rootId, result)
    const jobId = backgroundJobId(event)
    return {
      ...state,
      calls,
      ...(jobId === undefined || state.job !== undefined
        ? {}
        : { job: { jobId, status: 'running' } }),
    }
  }
  if (isEvent(event, 'subagent/started')) {
    const data = event.data
    return {
      ...state,
      subagent: {
        childSessionId: data.subagentId,
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
  if (isEvent(event, 'job/started')) {
    const data = event.data
    const { turn, step } = matchCoordinates(match)
    const callId = jobCallId(data.jobId)
    return {
      ...withChild(state, callId, {
        callId,
        name: `job:${data.kind}`,
        argsRaw: JSON.stringify({
          command: data.command,
          ...(data.description === undefined
            ? {}
            : { description: data.description }),
        }),
        turn,
        step,
        time: event.time,
        subCalls: [],
      }),
      job: {
        ...state.job,
        jobId: data.jobId,
        kind: data.kind,
        status: 'running',
      },
    }
  }
  if (isEvent(event, 'job/finished')) {
    const data = event.data
    const callId = jobCallId(data.jobId)
    const detail = [
      data.status,
      data.exitCode === undefined ? undefined : `exit code ${data.exitCode}`,
      data.detail,
    ]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ')
    return {
      ...withChild(
        state,
        callId,
        settledChild(
          match,
          state.calls.get(callId),
          {
            callId,
            name: `job:${data.kind}`,
            argsRaw: JSON.stringify({ command: data.command }),
          },
          detail,
          data.status !== 'completed',
        ),
      ),
      job: {
        jobId: data.jobId,
        kind: data.kind,
        status: data.status,
        ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
        ...(data.detail === undefined ? {} : { detail: data.detail }),
      },
    }
  }
  return applyWorkflow(state, match)
}

function withFacts(
  block: TrajectoryToolCallBlock,
  state: ToolState,
): TrajectoryToolCallBlock {
  const childSessionId = state.subagent?.childSessionId
  return {
    ...block,
    ...(state.subagent === undefined ? {} : { subagent: state.subagent }),
    ...(state.job === undefined ? {} : { job: state.job }),
    ...(state.workflow === undefined ? {} : { workflow: state.workflow }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
  }
}

/**
 * Project the root with its children. Only the root is interrupted by a
 * closed step: background jobs and workflow members outlive the step.
 */
function projectRoot(
  state: ToolState,
  interruptedAt: { seq: number; time: number } | undefined,
): TrajectoryToolCallBlock | undefined {
  const root = state.calls.get(state.rootId)
  if (root === undefined) return undefined
  const subCalls = state.children.flatMap((id) => {
    const child = state.calls.get(id)
    return child === undefined ? [] : [child]
  })
  if ('kind' in root || interruptedAt === undefined)
    return withFacts({ ...root, subCalls }, state)
  return withFacts(
    {
      kind: 'tool-result',
      seq: interruptedAt.seq - 0.8,
      time: interruptedAt.time,
      callId: root.callId,
      call: { name: root.name, argsRaw: root.argsRaw },
      callTime: root.time,
      content: [],
      isError: true,
      error: { name: 'Interrupted', code: 'interrupted' },
      subCalls,
    },
    state,
  )
}

function fold(context: ConversationNodeContext<ToolState>): ToolState {
  let state = emptyState(context.id)
  for (const match of context.matches) state = applyMatch(state, match)
  return state
}

/** Trajectory-owned root tool lifecycle with Emperor enrichment. */
export const trajectoryToolDefinition: ConversationDefinition<ToolState> = {
  kind: 'trajectory-tool-call',
  target: 'trajectory',
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
    return links
  },
  match: (event) => {
    if (isEvent(event, 'tool/call'))
      return { id: String(event.data.callId), role: 'start' }
    const callId = resultCallId(event)
    if (callId !== undefined) return { id: callId, role: 'update' }
    if (isEvent(event, 'subagent/started'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    if (isEvent(event, 'subagent/settled'))
      return {
        via: { ns: 'subagent', key: event.data.subagentId },
        role: 'update',
      }
    if (isEvent(event, 'job/started') || isEvent(event, 'job/finished'))
      return { via: { ns: 'job', key: event.data.jobId }, role: 'update' }
    if (isEvent(event, 'tool-workflow/run-start'))
      return event.data.callId === undefined
        ? null
        : { id: event.data.callId, role: 'update' }
    const runId = workflowRunId(event)
    if (runId !== undefined)
      return { via: { ns: 'workflow', key: runId }, role: 'update' }
    return null
  },
  start: (context, match) => applyMatch(emptyState(context.id), match),
  update: (context, match) => applyMatch(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? fold(context)
    const root = projectRoot(state, closedBoundaryOf(context.start?.location))
    if (root === undefined) return null
    const anchorSeq =
      context.start?.event.seq ??
      ('kind' in root ? root.seq : (context.matches[0]?.event.seq ?? 0))
    return trajectoryNode(context, anchorSeq, { kind: 'tool', root })
  },
}

/**
 * Workflow runs not started by a tool call in this session: a standalone
 * root record named after the run, with its members as subtools.
 */
export const trajectoryWorkflowRunDefinition: ConversationDefinition<ToolState | null> =
  {
    kind: 'trajectory-workflow-run',
    target: 'trajectory',
    match: (event) => {
      const runId = workflowRunId(event)
      if (runId === undefined) return null
      return {
        id: runId,
        role: event.type === 'tool-workflow/run-start' ? 'start' : 'update',
      }
    },
    start: (context, match) => {
      const event = match.event
      if (!isEvent(event, 'tool-workflow/run-start')) return null
      if (event.data.callId !== undefined) return null
      const { turn, step } = matchCoordinates(match)
      const rootId = `workflow:${event.data.runId}`
      const calls = new Map<string, TrajectoryToolCallBlock>()
      calls.set(rootId, {
        callId: rootId,
        name: event.data.tool ?? 'workflow',
        argsRaw: JSON.stringify({
          name: event.data.name,
          ...(event.data.description === undefined
            ? {}
            : { description: event.data.description }),
        }),
        turn,
        step,
        time: event.time,
        subCalls: [],
      })
      return applyWorkflow({ ...emptyState(rootId), calls }, match)
    },
    update: (context, match) => {
      const state = context.state
      if (state === null) return null
      const next = applyWorkflow(state, match)
      const event = match.event
      if (!isEvent(event, 'tool-workflow/run-end')) return next
      const root = next.calls.get(next.rootId)
      if (root === undefined || 'kind' in root) return next
      const calls = new Map(next.calls)
      calls.set(next.rootId, {
        kind: 'tool-result',
        seq: event.seq,
        time: event.time,
        callId: root.callId,
        call: { name: root.name, argsRaw: root.argsRaw },
        callTime: root.time,
        content: textContent(
          event.data.result ?? event.data.error ?? event.data.stopReason,
        ),
        isError: event.data.stopReason !== 'completed',
        subCalls: [],
      })
      return { ...next, calls }
    },
    buildViewNode: (context) => {
      const state = context.state
      const seq = context.start?.event.seq
      if (state === undefined || state === null || seq === undefined)
        return null
      const root = projectRoot(state, undefined)
      return root === undefined
        ? null
        : trajectoryNode(context, seq, { kind: 'tool', root })
    },
  }
