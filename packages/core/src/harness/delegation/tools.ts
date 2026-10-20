import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
  type ToolRunContext,
} from '../tools/definition'
import type { Agent } from '../agent/agent'
import type { SubagentManager } from '../subagent/manager'
import {
  createSubagentTools,
  subagentInput,
  subagentDescription,
  SEND_MESSAGE_DESCRIPTION,
  SEND_MESSAGE_INPUT,
  INTERRUPT_AGENT_DESCRIPTION,
  INTERRUPT_AGENT_INPUT,
  LIST_AGENTS_DESCRIPTION,
  LIST_AGENTS_INPUT,
} from '../subagent/tools'
import type {
  DelegationOwner,
  DelegationRecord,
  DelegationResult,
  DelegationRunRecord,
  DelegationStart,
} from './types'
import { resultLine } from './notices'
import type { DelegationState } from './fold'
import { buildDelegationContext, type DelegationBriefInput } from './context'
import { jsonSchema } from '../tools/json-schema'
import { DelegationError } from './types'
import type { ApprovalOutcome } from '../tools/registry'
import { delegationNeedsExit } from '../../runtime/agent-view'

/**
 * The local subagent tools keep main's descriptions and parameters
 * (AGT-05, SUB-27); everything about external executors lives in the
 * optional fields below, each saying it applies to external backends.
 */
const EXTERNAL_START_FIELDS = {
  backend: z
    .enum(['internal', 'claude-code', 'codex'])
    .optional()
    .describe(
      'Who runs the task. internal (default) is an Emperor subagent and needs none of the external fields. ' +
        'claude-code or codex hands it to that local CLI when it is enabled in Settings (the runtime context lists enabled executors): ' +
        'Emperor asks the user once before the first dispatch to each executor, since it uses their own quota or API billing, ' +
        'and runs the task as an internal subagent if they decline. External children get an isolated or brief context ' +
        '(never a fork of this conversation), are continued with send_message and collected with collect_agent.',
    ),
  profile_id: z
    .string()
    .optional()
    .describe('External backends only: a specific executor profile id.'),
  context: z
    .enum(['isolated', 'brief', 'fork'])
    .optional()
    .describe(
      'External backends only: isolated (default) sends just the prompt; brief adds workspace instructions and the goal. fork is internal only.',
    ),
  workspace: z
    .enum(['isolated-worktree', 'shared-readonly', 'shared-exclusive'])
    .optional()
    .describe(
      'External backends only: where the child works. shared-readonly reviews without writing (the only choice in Plan mode or a read-only session, and the default outside Git); isolated-worktree (default otherwise) writes in a separate worktree (a folder copy outside Git), and its changes come back as a result to apply.',
    ),
  base: z
    .enum(['committed', 'snapshot'])
    .optional()
    .describe(
      'External backends only: the code a writing child starts from: snapshot (default) is the workspace as it is now, uncommitted and new files included (.gitignore respected); committed is the last commit only (use it above 10,000 changed files).',
    ),
  model: z
    .string()
    .optional()
    .describe(
      "External backends only: the executor's model id; omit to use its default.",
    ),
  output_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'External backends only: a JSON schema the final answer must match.',
    ),
}
export interface DelegationToolService {
  start(
    owner: DelegationOwner,
    spec: DelegationStart,
  ): Promise<DelegationRecord>
  inspect(id: string): DelegationState
  list(): DelegationState[]
  send(
    id: string,
    input: {
      messageId: string
      text: string
      delivery: 'queue' | 'steer'
      expectedRunId?: string
      signal?: AbortSignal
    },
  ): Promise<{
    messageId: string
    state: 'queued' | 'accepted'
    runId?: string
  }>
  interrupt(id: string, runId: string): Promise<{ requested: boolean }>
  wait(
    id: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<DelegationRunRecord>
  /** End a run that has no outcome (AGT-04). */
  abandon?(id: string, by: 'user' | 'model'): Promise<DelegationRecord>
  /** Apply a run's result to the project (AGT-06). */
  applyResult?(
    id: string,
    runId: string,
    by: 'user' | 'model',
  ): Promise<DelegationResult>
}
export interface DelegationToolOptions {
  internalManager: SubagentManager
  delegations: () => DelegationToolService | undefined
  ownerResolver: (agent: Agent, callId: string) => DelegationOwner
  canControl: (agent: Agent, owner: DelegationOwner) => boolean
  briefContext?: (
    agent: Agent,
  ) => Omit<DelegationBriefInput, 'prompt' | 'description' | 'context'>
  parentReadOnly?: (agent: Agent) => boolean
  /** The parent works in a Git project (absent: assumed). Outside Git a task defaults to a review (AGT-06). */
  parentInGit?: (agent: Agent) => boolean
  /** Ask the user (collect_agent abandon, apply); absent: the request fails closed. */
  approve?: (request: {
    agent: Agent
    callId: string
    reason: string
    signal: AbortSignal
  }) => Promise<ApprovalOutcome>
}
function messageId(owner: DelegationOwner, callId: string, id: string): string {
  // RFC 4122 UUIDv5 over host-owned call scope. A replay reuses the same message identity.
  const bytes = createHash('sha1')
    .update(Buffer.from('29a559a4b41446e4bf3f12c2143b8b9a', 'hex'))
    .update(
      JSON.stringify([owner.rootSessionId, owner.parentAgentId, callId, id]),
    )
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 0x50
  bytes[8] = (bytes[8]! & 63) | 0x80
  const hex = bytes.toString('hex')
  return (
    'dgm-' +
    [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-')
  )
}
function closingText(
  record: DelegationRecord,
  run: DelegationRunRecord,
): string {
  return (
    JSON.stringify({
      delegationId: record.id,
      runId: run.id,
      backend: record.backend,
      cwd: record.cwd,
      phase: run.phase,
      acceptance: run.acceptance,
      receiptId: run.receiptId,
      providerSessionId: record.providerSessionId,
      providerTurnId: run.providerTurnId,
    }) +
    resultLine(run) +
    '\n' +
    (run.summary ?? '(executor returned no closing text)')
  )
}
const executorName = (backend: string) =>
  backend === 'codex' ? 'Codex' : 'Claude Code'
/** Tell the model the task ran locally because the user said no. */
function withConsentNote(
  result: Awaited<ReturnType<ToolDefinition['execute']>>,
  backend: string,
): Awaited<ReturnType<ToolDefinition['execute']>> {
  const note = `The user did not allow ${executorName(backend)} for this task, so it runs as an internal subagent instead.`
  if (typeof result === 'string') return note + '\n' + result
  if (Array.isArray(result)) return [{ type: 'text', text: note }, ...result]
  const content = result.content
  return {
    ...result,
    content:
      typeof content === 'string'
        ? note + '\n' + content
        : [{ type: 'text', text: note }, ...content],
    meta: {
      ...(result.meta && typeof result.meta === 'object'
        ? (result.meta as Record<string, unknown>)
        : {}),
      requestedBackend: backend,
      consent: 'denied',
    },
  }
}
export function createDelegationTools(
  options: DelegationToolOptions,
): ToolDefinition[] {
  const legacy = new Map(
    createSubagentTools(options.internalManager).map((t) => [t.name, t]),
  )
  const service = () => {
    const s = options.delegations()
    if (!s)
      throw new ToolError(
        'external executor service is not composed',
        'EXECUTOR_UNAVAILABLE',
      )
    return s
  }
  const caller = (context: ToolRunContext) => {
    if (!context.agent)
      throw new ToolError(
        'delegation tool requires a calling agent',
        'PERMISSION_DENIED',
      )
    return context.agent
  }
  const route = (id: string): 'internal' | 'external' => {
    if (/^sub-/.test(id)) return 'internal'
    if (/^dlg-/.test(id)) return 'external'
    throw new ToolError('unknown agent id namespace', 'INVALID_ID')
  }
  const owned = (id: string, context: ToolRunContext) => {
    const agent = caller(context),
      state = service().inspect(id)
    if (!state.record || !options.canControl(agent, state.record.owner))
      throw new ToolError(
        'external conversation is not owned by this agent',
        'PERMISSION_DENIED',
      )
    return state
  }
  const invoke = async (name: string, args: unknown, ctx: ToolRunContext) => {
    const tool = legacy.get(name)!
    return tool.execute(tool.parse(args), ctx)
  }
  const start = (name: 'subagent' | 'subagent_fork') =>
    defineTool({
      category: 'agents',
      name,
      description: subagentDescription(name === 'subagent' ? 'spawn' : 'fork'),
      input: subagentInput(name === 'subagent' ? 'spawn' : 'fork').extend(
        EXTERNAL_START_FIELDS,
      ),
      isConcurrencySafe: () => true,
      execute: async (args, ctx) => {
        const agent = caller(ctx)
        if (!args.backend || args.backend === 'internal')
          return invoke(name, args, ctx)
        if (name === 'subagent_fork' || args.context === 'fork')
          throw new ToolError(
            'external executors cannot fork internal conversation history',
            'UNSUPPORTED_CONTEXT_MODE',
          )
        if (ctx.signal.aborted)
          throw new ToolError('parent turn was cancelled', 'ABORTED')
        const owner = options.ownerResolver(agent, ctx.callId),
          context = args.context ?? 'isolated',
          // Outside Git, or a read-only parent: a review in place. A write
          // starts from the workspace as it is now (AGT-06).
          workspace =
            args.workspace ??
            (options.parentReadOnly?.(agent) ||
            options.parentInGit?.(agent) === false
              ? 'shared-readonly'
              : 'isolated-worktree'),
          base =
            args.base ??
            (workspace === 'shared-readonly' ? 'committed' : 'snapshot')
        if (args.output_schema)
          jsonSchema.assertObjectJsonSchema(args.output_schema)
        const prompt = buildDelegationContext({
          ...(options.briefContext?.(agent) ?? {}),
          prompt: args.prompt,
          description: args.description,
          context,
        })
        let record: DelegationRecord
        try {
          record = await service().start(owner, {
            backend: args.backend,
            profileId: args.profile_id,
            description: args.description,
            prompt,
            context,
            workspace,
            base,
            model: args.model,
            outputSchema: args.output_schema,
            runInBackground: args.run_in_background ?? true,
            clientRequestId: ctx.callId,
          })
        } catch (error) {
          if (
            !(error instanceof DelegationError) ||
            error.code !== 'EXECUTOR_CONSENT_DENIED'
          )
            throw error
          // The user kept their quota: the same task runs locally.
          return withConsentNote(
            await invoke(
              name,
              {
                description: args.description,
                prompt: args.prompt,
                ...(args.run_in_background === undefined
                  ? {}
                  : { run_in_background: args.run_in_background }),
              },
              ctx,
            ),
            args.backend,
          )
        }
        const meta = {
          kind: 'continuable',
          subagentId: record.id,
          runId: record.currentRunId,
          backend: record.backend,
          profileId: record.profileId,
          acceptance: 'unverified',
        }
        if (args.run_in_background !== false)
          return {
            content:
              'accepted external delegation ' +
              record.id +
              '; run ' +
              record.currentRunId +
              ' is queued',
            meta,
          }
        const abort = () => {
          if (record.currentRunId)
            void service()
              .interrupt(record.id, record.currentRunId)
              .catch(() => undefined)
        }
        ctx.signal.addEventListener('abort', abort, { once: true })
        if (ctx.signal.aborted) abort()
        try {
          // Stopping the turn ends the wait at once; the run is interrupted.
          const run = await service().wait(
            record.id,
            record.currentRunId!,
            ctx.signal,
          )
          if (run.phase !== 'completed')
            throw new ToolError(
              'external run ' +
                run.phase +
                ': ' +
                (run.failureCode ?? run.summary ?? ''),
              'DELEGATION_FAILED',
            )
          return {
            content: closingText(service().inspect(record.id).record!, run),
            meta: {
              ...meta,
              kind: 'foreground',
              phase: run.phase,
              acceptance: run.acceptance,
              ...(run.structured === undefined
                ? {}
                : { structured: run.structured }),
            },
          }
        } finally {
          ctx.signal.removeEventListener('abort', abort)
        }
      },
    })
  /** collect_agent({apply}): the user decides on an approval card (AGT-06). */
  const applyResult = async (
    id: string,
    runId: string,
    state: DelegationState,
    ctx: ToolRunContext,
  ) => {
    const run = state.runs[runId]!,
      result = run.result
    if (!result || result.totals.files === 0)
      throw new ToolError(
        'NOTHING_TO_APPLY: run ' + runId + ' left no changed files',
        'NOTHING_TO_APPLY',
      )
    if (result.state !== 'ready' && result.state !== 'conflicted')
      throw new ToolError(
        'RESULT_SETTLED: the result of run ' +
          runId +
          ' was already ' +
          result.state,
        'RESULT_SETTLED',
      )
    const s = service()
    if (!s.applyResult || !options.approve)
      throw new ToolError(
        'applying a result needs the user, but no approval channel is available',
        'APPROVAL_UNAVAILABLE',
      )
    const { files, additions, deletions } = result.totals
    const outcome = await options.approve({
      agent: caller(ctx),
      callId: ctx.callId,
      reason:
        'Apply the result of external task "' +
        (state.record!.startSpec?.description || id) +
        '" (' +
        id +
        ', run ' +
        runId +
        '): ' +
        files +
        (files === 1 ? ' file' : ' files') +
        ' +' +
        additions +
        ' −' +
        deletions +
        ', merged into the current workspace. A conflict applies nothing.',
      signal: ctx.signal,
    })
    if (outcome !== 'allowed-once')
      throw new ToolError(
        outcome === 'rejected'
          ? 'APPROVAL_REJECTED: the user did not allow applying this result'
          : 'APPROVAL_' +
              outcome.toUpperCase() +
              ': applying this result was not approved',
        outcome === 'rejected'
          ? 'APPROVAL_REJECTED'
          : 'APPROVAL_' + outcome.toUpperCase(),
      )
    const applied = await s.applyResult(id, runId, 'model')
    const meta = {
      subagentId: id,
      runId,
      result: {
        state: applied.state,
        totals: applied.totals,
        ...(applied.conflicts ? { conflicts: applied.conflicts } : {}),
      },
    }
    if (applied.state === 'conflicted')
      return {
        content:
          'Not applied: these files also changed in the project: ' +
          (applied.conflicts ?? []).join(', ') +
          '. Nothing was written; the result is kept for the user to resolve or discard.',
        meta,
        isError: true,
      }
    return {
      content:
        'Applied ' +
        applied.totals.files +
        (applied.totals.files === 1 ? ' file' : ' files') +
        " to the project with the user's approval: " +
        applied.files.map((file) => file.path).join(', '),
      meta,
    }
  }
  return [
    start('subagent'),
    start('subagent_fork'),
    defineTool({
      category: 'agents',
      name: 'send_message',
      description: SEND_MESSAGE_DESCRIPTION,
      input: SEND_MESSAGE_INPUT.extend({
        delivery: z
          .enum(['queue', 'steer'])
          .optional()
          .describe(
            'External children only: queue (default) waits for the current turn; steer redirects a running Codex turn (needs expected_run_id; Claude Code cannot steer).',
          ),
        expected_run_id: z
          .string()
          .optional()
          .describe(
            'External children only: the run id a steer must still match.',
          ),
      }),
      execute: async (args, ctx) => {
        if (route(args.subagent_id) === 'internal') {
          if (args.delivery === 'steer')
            throw new ToolError(
              'internal send_message queues a later turn',
              'UNSUPPORTED_OPTION',
            )
          return invoke('send_message', args, ctx)
        }
        const state = owned(args.subagent_id, ctx),
          owner = options.ownerResolver(caller(ctx), ctx.callId),
          id = messageId(owner, ctx.callId, args.subagent_id)
        const result = await service().send(args.subagent_id, {
          messageId: id,
          text: args.message,
          delivery: args.delivery ?? 'queue',
          expectedRunId: args.expected_run_id,
          signal: ctx.signal,
        })
        return {
          content: 'message ' + result.state + ' for ' + state.record!.id,
          meta: {
            ...result,
            subagentId: args.subagent_id,
            delivery: args.delivery ?? 'queue',
          },
        }
      },
    }),
    defineTool({
      category: 'agents',
      name: 'interrupt_agent',
      description: INTERRUPT_AGENT_DESCRIPTION,
      input: INTERRUPT_AGENT_INPUT.extend({
        expected_run_id: z
          .string()
          .optional()
          .describe(
            'External children only: the run to stop; defaults to the current run. Stopping an external child also cancels its queued messages.',
          ),
      }),
      execute: async (args, ctx) => {
        if (route(args.agent_id) === 'internal')
          return invoke('interrupt_agent', args, ctx)
        const state = owned(args.agent_id, ctx),
          runId = args.expected_run_id ?? state.record!.currentRunId
        if (!runId)
          return {
            content: 'external conversation is idle',
            meta: { accepted: false },
          }
        const result = await service().interrupt(args.agent_id, runId)
        return {
          content:
            'interrupt ' +
            (result.requested ? 'requested' : 'already settled') +
            ' for ' +
            args.agent_id,
          meta: {
            accepted: result.requested,
            subagentId: args.agent_id,
            runId,
          },
        }
      },
    }),
    defineTool({
      category: 'agents',
      name: 'list_agents',
      description: LIST_AGENTS_DESCRIPTION,
      input: LIST_AGENTS_INPUT,
      isConcurrencySafe: () => true,
      execute: async (args, ctx) => {
        const agent = caller(ctx),
          external = (options.delegations()?.list() ?? []).filter(
            (s) =>
              s.record &&
              options.canControl(agent, s.record.owner) &&
              (args.scope === 'descendants' ||
                s.record.owner.parentAgentId === agent.id),
          )
        if (!external.length) return invoke('list_agents', args, ctx)
        const internal = options.internalManager.list(
            agent,
            args.scope ?? 'children',
          ),
          agents = [
            ...internal,
            ...external.map((s) => ({
              id: s.record!.id,
              backend: s.record!.backend,
              profileId: s.record!.profileId,
              description: s.record!.startSpec?.description ?? '',
              status: s.record!.currentRunId
                ? s.runs[s.record!.currentRunId]?.phase
                : s.record!.availability,
              runId: s.record!.currentRunId,
              depth: s.record!.owner.depth,
            })),
          ]
        return {
          content: agents
            .map((a) => '- ' + a.id + ' [' + a.status + ']: ' + a.description)
            .join('\n'),
          meta: { agents },
        }
      },
    }),
    defineTool({
      category: 'agents',
      name: 'inspect_agent',
      description:
        'Inspect an owned child conversation and its run identity without consuming output.',
      input: z.object({ agent_id: z.string() }),
      isConcurrencySafe: () => true,
      execute: async (args, ctx) => {
        if (route(args.agent_id) === 'internal') {
          const agent = caller(ctx)
          const record = options.internalManager
            .list(agent, 'descendants')
            .find((r) => r.id === args.agent_id)
          if (!record)
            throw new ToolError(
              'internal agent is not a held descendant',
              'PERMISSION_DENIED',
            )
          return { content: JSON.stringify(record), meta: { agent: record } }
        }
        const state = owned(args.agent_id, ctx)
        return {
          content: JSON.stringify(state.record),
          meta: { agent: state.record, runs: Object.values(state.runs) },
        }
      },
    }),
    defineTool({
      category: 'agents',
      name: 'collect_agent',
      description:
        'Wait for a specific external run and collect its summary, structured output and delivery check state. Successful text results can be used directly. A writing run changes files only in its isolated workspace; its result lists them, and apply=true asks the user to apply them to the project (a three-way merge into the current workspace; a conflict applies nothing and lists the files). Check changed files before final delivery; execution completion is not evidence that tests passed. ' +
        'If the last run ended without an outcome (Emperor or the computer restarted, or its stop could not be confirmed), abandon=true asks the user to mark it as ended, which releases its workspace and lets the task and any Goal move on.',
      input: z.object({
        agent_id: z.string(),
        expected_run_id: z.string().optional(),
        abandon: z
          .boolean()
          .optional()
          .describe(
            'Mark the run as ended as it is, after the user approves. Only for a run that has no outcome; a live run is stopped with interrupt_agent.',
          ),
        apply: z
          .boolean()
          .optional()
          .describe(
            "Apply the settled run's changed files to the project, after the user approves on an approval card.",
          ),
      }),
      execute: async (args, ctx) => {
        if (route(args.agent_id) === 'internal')
          throw new ToolError(
            'internal agents deliver their results through the existing report/settlement path',
            'UNSUPPORTED_OPTION',
          )
        const state = owned(args.agent_id, ctx),
          runId = args.expected_run_id ?? state.record!.currentRunId
        if (!runId || !state.runs[runId])
          throw new ToolError(
            'run is not part of this conversation',
            'RUN_NOT_FOUND',
          )
        if (args.apply) return applyResult(args.agent_id, runId, state, ctx)
        if (args.abandon) {
          const run = state.runs[runId]!
          if (
            runId !== state.record!.currentRunId ||
            !delegationNeedsExit(state.record, run)
          )
            throw new ToolError(
              'NOTHING_TO_END: run ' +
                runId +
                ' is ' +
                run.phase +
                '; only a run without an outcome can be marked as ended (stop a live run with interrupt_agent)',
              'NOTHING_TO_END',
            )
          const s = service()
          if (!s.abandon || !options.approve)
            throw new ToolError(
              'marking a run as ended needs the user, but no approval channel is available',
              'APPROVAL_UNAVAILABLE',
            )
          const outcome = await options.approve({
            agent: caller(ctx),
            callId: ctx.callId,
            reason:
              'Mark external task "' +
              (state.record!.startSpec?.description || args.agent_id) +
              '" (' +
              args.agent_id +
              ', run ' +
              runId +
              ', ' +
              run.phase +
              ') as ended. It releases its workspace; its retained files are kept.',
            signal: ctx.signal,
          })
          if (outcome !== 'allowed-once')
            throw new ToolError(
              outcome === 'rejected'
                ? 'APPROVAL_REJECTED: the user did not allow marking this run as ended'
                : 'APPROVAL_' +
                    outcome.toUpperCase() +
                    ': marking this run as ended was not approved',
              outcome === 'rejected'
                ? 'APPROVAL_REJECTED'
                : 'APPROVAL_' + outcome.toUpperCase(),
            )
          await s.abandon(args.agent_id, 'model')
          const ended = s.inspect(args.agent_id)
          return {
            content:
              closingText(ended.record!, ended.runs[runId]!) +
              "\nMarked as ended with the user's approval.",
            meta: {
              subagentId: args.agent_id,
              runId,
              phase: ended.runs[runId]!.phase,
              abandoned: true,
            },
          }
        }
        const run = await service().wait(args.agent_id, runId, ctx.signal)
        return {
          content: closingText(service().inspect(args.agent_id).record!, run),
          meta: {
            subagentId: args.agent_id,
            runId,
            phase: run.phase,
            acceptance: run.acceptance,
            ...(run.receiptId === undefined
              ? {}
              : { receiptId: run.receiptId }),
            ...(run.structured === undefined
              ? {}
              : { structured: run.structured }),
          },
          isError: run.phase !== 'completed',
        }
      },
    }),
  ]
}
