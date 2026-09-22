// Workflow / ralph run fold (run → phases → members) shared by the tool node
// (runs started by a tool call) and the standalone workflowRun node.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type { ConversationDefinition } from '../assembler'
import { isEvent } from '../events'
import type {
  WorkflowMemberView,
  WorkflowPhaseView,
  WorkflowRunView,
} from '../types'
import { chatNode } from './common'

/** Narration lines kept per run. */
const MAX_LOGS = 50

const WORKFLOW_TYPES = new Set([
  'tool-workflow/run-start',
  'tool-workflow/phase',
  'tool-workflow/log',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  'tool-workflow/run-end',
])

/** Whether an event belongs to the workflow vocabulary. */
export function isWorkflowEvent(event: WireSessionEvent): boolean {
  return WORKFLOW_TYPES.has(event.type)
}

/** runId carried by a workflow event. */
export function workflowRunId(event: WireSessionEvent): string | undefined {
  if (!isWorkflowEvent(event)) return undefined
  const runId = (event.data as { runId?: unknown }).runId
  return typeof runId === 'string' && runId !== '' ? runId : undefined
}

function withMember(
  phases: readonly WorkflowPhaseView[],
  title: string,
  member: WorkflowMemberView,
): WorkflowPhaseView[] {
  const index = phases.findIndex((phase) => phase.title === title)
  if (index < 0) return [...phases, { title, members: [member] }]
  return phases.map((phase, at) =>
    at === index ? { ...phase, members: [...phase.members, member] } : phase,
  )
}

interface WorkflowFold {
  readonly view: WorkflowRunView
  /** Phase title new members join when they name none. */
  readonly currentPhase: string
}

/** Fold one workflow event into a run (undefined before run-start). */
export function foldWorkflow(
  previous: WorkflowFold | undefined,
  event: WireSessionEvent,
): WorkflowFold | undefined {
  if (isEvent(event, 'tool-workflow/run-start')) {
    const data = event.data
    return {
      currentPhase: '',
      view: {
        runId: data.runId,
        name: data.name,
        status: 'running',
        phases: [],
        logs: [],
        ...(data.description === undefined
          ? {}
          : { description: data.description }),
        ...(data.tool === undefined ? {} : { tool: data.tool }),
        ...(data.callId === undefined ? {} : { callId: data.callId }),
      },
    }
  }
  if (previous === undefined) return undefined
  const view = previous.view
  if (isEvent(event, 'tool-workflow/phase')) {
    const title = event.data.title
    const phases = view.phases.some((phase) => phase.title === title)
      ? view.phases
      : [...view.phases, { title, members: [] }]
    return { currentPhase: title, view: { ...view, phases } }
  }
  if (isEvent(event, 'tool-workflow/log')) {
    const logs = [...view.logs, event.data.message].slice(-MAX_LOGS)
    return { ...previous, view: { ...view, logs } }
  }
  if (isEvent(event, 'tool-workflow/agent-start')) {
    const data = event.data
    const member: WorkflowMemberView = {
      seq: data.seq,
      label: data.label,
      childId: data.childId,
    }
    return {
      ...previous,
      view: {
        ...view,
        phases: withMember(
          view.phases,
          data.phase ?? previous.currentPhase,
          member,
        ),
      },
    }
  }
  if (isEvent(event, 'tool-workflow/agent-end')) {
    const data = event.data
    const phases = view.phases.map((phase) =>
      phase.members.some((member) => member.seq === data.seq)
        ? {
            ...phase,
            members: phase.members.map((member) =>
              member.seq === data.seq
                ? { ...member, outcome: data.outcome }
                : member,
            ),
          }
        : phase,
    )
    return { ...previous, view: { ...view, phases } }
  }
  if (isEvent(event, 'tool-workflow/run-end')) {
    const data = event.data
    return {
      ...previous,
      view: {
        ...view,
        status: data.stopReason,
        ...(data.agentsStarted === undefined
          ? {}
          : { agentsStarted: data.agentsStarted }),
        ...(data.error === undefined ? {} : { error: data.error }),
        ...(data.result === undefined ? {} : { result: data.result }),
      },
    }
  }
  return previous
}

/**
 * Workflow runs not started by a tool call in this session (no `callId`);
 * runs with a call render inside their tool node instead.
 */
export const workflowRunDefinition: ConversationDefinition<WorkflowFold | null> =
  {
    kind: 'workflowRun',
    target: 'chat',
    match: (event) => {
      const runId = workflowRunId(event)
      if (runId === undefined) return null
      return {
        id: runId,
        role: event.type === 'tool-workflow/run-start' ? 'start' : 'update',
      }
    },
    start: (_context, match) => {
      if (!isEvent(match.event, 'tool-workflow/run-start')) return null
      if (match.event.data.callId !== undefined) return null
      return foldWorkflow(undefined, match.event) ?? null
    },
    update: (context, match) =>
      context.state === null
        ? null
        : (foldWorkflow(context.state, match.event) ?? context.state),
    buildViewNode: (context) => {
      const state = context.state
      const seq = context.start?.event.seq
      if (state === undefined || state === null || seq === undefined)
        return null
      return chatNode(context, 'workflowRun', seq, state.view)
    },
  }
