/** Delegation tools (ported from dsh tool-subagent, tool-subagent-control, tool-subagent-report). */

import { z } from 'zod'
import type { SystemPromptAssembler } from '../prompt/assembler'
import {
  defineTool,
  ToolArgsError,
  ToolError,
  type ToolDefinition,
} from '../tools/definition'
import { jsonSchema } from '../tools/json-schema'
import type { ToolCallInfo, ToolRegistry } from '../tools/registry'
import {
  SUBAGENT_DELEGATION_CONTEXT,
  type SubagentManager,
  type SubagentMode,
  type SubagentSettlement,
} from './manager'

function wording(mode: SubagentMode): {
  description: string
  promptDescription: string
} {
  if (mode === 'fork') {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all ' +
        'completed turns so far (it does not see the current in-flight turn). Use this when the subtask ' +
        "builds on this conversation's context — a follow-up analysis, " +
        "a review, a continuation — without consuming this conversation's context for the work itself. " +
        'You receive its result, not its intermediate steps.',
      promptDescription:
        "The task for the subagent. It already sees this conversation's completed turns, so build on them " +
        'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) ' +
      'to offload focused, independent work — research, a scoped ' +
      "implementation, an analysis — so it does not consume this conversation's context. The subagent " +
      'returns its result, not its intermediate steps. Give it a ' +
      'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this ' +
      "conversation's context, so include everything it needs.",
  }
}

const CONTINUABLE_NOTE =
  ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'

function stopReasonError(settlement: SubagentSettlement): string | undefined {
  switch (settlement.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    case 'interrupted':
      return 'subagent run was interrupted'
  }
}

function delegationTool(
  manager: SubagentManager,
  mode: SubagentMode,
  name: string,
): ToolDefinition {
  const words = wording(mode)
  return defineTool({
    name,
    description: words.description + CONTINUABLE_NOTE,
    input: z.object({
      description: z
        .string()
        .describe(
          'A short (3-5 word) description of the delegated task, for display.',
        ),
      prompt: z.string().describe(words.promptDescription),
      run_in_background: z
        .boolean()
        .optional()
        .describe(
          'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.',
        ),
    }),
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const parent = context.agent
      if (parent === undefined)
        throw new ToolError('subagent tool requires a calling agent')
      const background = args.run_in_background ?? true
      const child = manager.start(parent, {
        description: args.description,
        prompt: args.prompt,
        mode,
        callId: context.callId,
        background,
      })
      if (background) {
        return {
          content: `started subagent ${child.id}`,
          meta: {
            kind: 'continuable',
            subagentId: child.id,
            description: args.description,
            mode,
          },
        }
      }
      const settlement = await manager.waitForSettlement(
        child.id,
        context.signal,
      )
      const error = stopReasonError(settlement)
      if (error !== undefined) {
        const diagnostic =
          settlement.failure === undefined
            ? ''
            : `\nDiagnostic: ${settlement.failure}`
        const partial =
          settlement.text === undefined
            ? ''
            : `\nPartial output before the run ended:\n${settlement.text}`
        throw new ToolError(
          `${error}${diagnostic}${partial}`,
          'SUBAGENT_FAILED',
        )
      }
      return {
        content: settlement.text ?? '(the subagent left no closing message)',
        meta: {
          kind: 'foreground',
          subagentId: child.id,
          description: args.description,
          mode,
        },
      }
    },
  })
}

export function createSubagentTools(
  manager: SubagentManager,
): ToolDefinition[] {
  return [
    delegationTool(manager, 'spawn', 'subagent'),
    delegationTool(manager, 'fork', 'subagent_fork'),
    defineTool({
      name: 'send_message',
      description:
        'Send a message to a background subagent by its subagent id, continuing the same conversation. It ' +
        "becomes the subagent's next turn: if it is still working, the message waits until its current turn " +
        'finishes, so it cannot redirect work already underway. This call returns no answer from the ' +
        'subagent — only confirmation that the message was delivered — so use it to give it more work. A ' +
        'failure means the message was NOT delivered.',
      input: z.object({
        subagent_id: z
          .string()
          .describe(
            'The subagent id returned when the background subagent was started.',
          ),
        message: z.string().describe('The message to deliver to the subagent.'),
      }),
      async execute(args, context) {
        if (context.agent === undefined)
          throw new ToolError('send_message requires a calling agent')
        const messageId = manager.followup(
          context.agent,
          args.subagent_id,
          args.message,
        )
        return {
          content: `message queued as the next turn for subagent ${args.subagent_id}`,
          meta: { messageId, subagentId: args.subagent_id },
        }
      },
    }),
    defineTool({
      name: 'interrupt_agent',
      description:
        "Request cancellation of a background agent's current turn by its agent id. The target may be your " +
        'direct child or a deeper agent created under you. Only the current turn stops: messages already ' +
        'queued for the agent stay parked until a later send_message, agents it started keep running, and ' +
        'the agent itself stays available for follow-ups. This call returns as soon as the stop request is ' +
        'accepted, so the target may keep running briefly; interrupting an agent that already finished is ' +
        'an accepted no-op.',
      input: z.object({
        agent_id: z
          .string()
          .describe('The agent id of the running agent to interrupt.'),
      }),
      async execute(args, context) {
        if (context.agent === undefined)
          throw new ToolError('interrupt_agent requires a calling agent')
        manager.interrupt(args.agent_id, {
          kind: 'ancestor',
          agent: context.agent,
        })
        return {
          content: `interrupt requested for agent ${args.agent_id}`,
          meta: { accepted: true },
        }
      },
    }),
    defineTool({
      name: 'list_agents',
      description:
        'List the background agents you started (children) or every agent under you (descendants), with their status.',
      input: z.object({
        scope: z.enum(['children', 'descendants']).optional(),
      }),
      isConcurrencySafe: () => true,
      async execute(args, context) {
        if (context.agent === undefined)
          throw new ToolError('list_agents requires a calling agent')
        const records = manager.list(context.agent, args.scope ?? 'children')
        if (records.length === 0)
          return { content: 'No background agents.', meta: { agents: [] } }
        const lines = records.map(
          (record) =>
            `- ${record.id} [${record.status}${record.lastStopReason === undefined ? '' : `, last: ${record.lastStopReason}`}] depth ${record.depth}: ${record.description}`,
        )
        return {
          content: lines.join('\n'),
          meta: { agents: records.map((record) => ({ ...record })) },
        }
      },
    }),
  ]
}

/** The child-only `report` tool. */
export function createReportTool(manager: SubagentManager): ToolDefinition {
  return defineTool({
    name: 'report',
    description:
      'Report selected content to the agent that started you. Call this once before you finish, with a ' +
      'self-contained final result, and earlier for progress or findings that change what that agent does ' +
      'next. That agent shares your workspace but does not automatically receive your transcript, tool ' +
      'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your ' +
      'turn or finish your work, and only your direct parent receives it. A failed call may still have ' +
      'arrived, so do not blindly repeat it.',
    input: z.object({
      output: z
        .string()
        .describe(
          'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
        ),
    }),
    async execute(args, context) {
      if (context.agent === undefined)
        throw new ToolError('report requires a calling agent')
      const messageId = manager.report(context.agent, args.output)
      return {
        content: `report accepted by the agent that started you as message ${messageId}`,
        meta: { messageId },
      }
    },
  })
}

/** The model-facing tool a structured child must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** Scoped instruction for structured children (dsh `STRUCTURED_OUTPUT_INSTRUCTION`). */
export const STRUCTURED_OUTPUT_INSTRUCTION =
  'When you have your final answer, you MUST report it by calling the ' +
  `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. ` +
  'Do not finish with a plain text answer: only the tool call counts as your result.'

/**
 * The structured-output capture tool (ported from dsh
 * subagent-in-process-driver `structured.ts`). Visible only to a child started
 * with an `outputSchema`; its parameter schema IS that child's schema. The body
 * validates and stages the value and concludes the turn; the value commits
 * only once the call's authoritative final result succeeded.
 */
export function createStructuredOutputTool(
  manager: SubagentManager,
): ToolDefinition<Record<string, unknown>> {
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; ' +
      "the arguments must match this tool's parameter schema exactly.",
    parameters: { type: 'object', additionalProperties: true },
    parametersFor: (agent) =>
      manager.structuredSchema(agent) as Record<string, unknown> | undefined,
    parse(raw: unknown): Record<string, unknown> {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new ToolArgsError(
          STRUCTURED_OUTPUT_TOOL,
          'arguments must be a JSON object',
        )
      return raw as Record<string, unknown>
    },
    async execute(args, context) {
      const schema = manager.structuredSchema(context.agent)
      if (context.agent === undefined || schema === undefined)
        throw new ToolError(
          'structured output was not requested for this agent',
        )
      const violations = jsonSchema.validateJsonSchemaValue(schema, args, '')
      if (violations.length > 0)
        throw new ToolArgsError(STRUCTURED_OUTPUT_TOOL, violations.join('; '))
      manager.stageStructured(context.agent, context.callId, args)
      context.concludeTurn()
      return 'Structured output recorded.'
    },
  }
}

/** Register the delegation tools, the child-only report tool, and their prompt parts. */
export function installSubagents(
  manager: SubagentManager,
  tools: ToolRegistry,
  prompt: SystemPromptAssembler,
): () => void {
  const disposers: Array<() => void> = []
  for (const tool of createSubagentTools(manager))
    disposers.push(tools.register(tool))
  disposers.push(
    tools.register(createReportTool(manager), {
      visible: (agent) => agent?.owner !== undefined,
    }),
  )
  disposers.push(
    tools.register(createStructuredOutputTool(manager), {
      visible: (agent) => manager.structuredSchema(agent) !== undefined,
    }),
  )
  const commit = (call: ToolCallInfo, result: { isError: boolean }): void => {
    if (call.name === STRUCTURED_OUTPUT_TOOL && call.agent !== undefined)
      manager.commitStructured(call.agent, call.callId, result.isError)
  }
  tools.observers.push(commit)
  // Terminal within the step: once the value committed, later calls are refused.
  const guard = (call: ToolCallInfo): string | undefined =>
    manager.structuredCaptured(call.agent)
      ? `structured output already recorded: the run is complete, so \`${call.name}\` is not executed`
      : undefined
  tools.guards.push(guard)
  disposers.push(() => {
    const observerIndex = tools.observers.indexOf(commit)
    if (observerIndex >= 0) tools.observers.splice(observerIndex, 1)
    const guardIndex = tools.guards.indexOf(guard)
    if (guardIndex >= 0) tools.guards.splice(guardIndex, 1)
  })
  disposers.push(
    prompt.section({
      name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
      order: 190,
      text: ({ agent }) =>
        manager.structuredSchema(agent) === undefined
          ? ''
          : STRUCTURED_OUTPUT_INSTRUCTION,
    }),
  )
  disposers.push(
    prompt.context({
      name: 'subagent:delegation',
      order: 120,
      text: ({ agent }) =>
        agent?.owner === undefined ? '' : SUBAGENT_DELEGATION_CONTEXT,
    }),
  )
  disposers.push(
    prompt.section({
      name: 'tool:subagent',
      order: 116.5,
      text: "Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.",
    }),
  )
  disposers.push(
    prompt.section({
      name: 'tool:report',
      order: 117,
      text: ({ agent }) =>
        agent?.owner === undefined
          ? ''
          : 'Deliver your result with the report tool before you finish: call it once with a self-contained ' +
            'answer. The agent that started you shares your workspace but does not automatically receive your ' +
            'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can ' +
            'use. Report earlier as well whenever a partial finding changes what that agent should do next; ' +
            'reporting never ends your turn.',
    }),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
