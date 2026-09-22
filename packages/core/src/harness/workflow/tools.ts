/**
 * The model-facing `workflow` and `ralph` tools (ported from
 * dsh-tool-workflow and dsh-tool-ralph).
 *
 * Both are foreground: `execute` starts a run and awaits `run.result` inside a
 * `try/finally` that always disposes the run, so the script and its children
 * reach quiescence on every path. `exec.signal` is bridged to `run.cancel()`.
 * A non-`completed` stop reason maps to an error result reporting the reason —
 * never partial output as success. Runs are registered with the host's
 * {@link WorkflowRunRegistry} for durable records and Task-panel cancellation.
 */

import { z } from 'zod'
import type { SystemPromptAssembler } from '../prompt/assembler'
import { defineTool, ToolError, type ToolDefinition } from '../tools/definition'
import type { ToolRegistry } from '../tools/registry'
import type { WorkflowEngine } from './engine'
import type { WorkflowRunRegistry, WorkflowRunTool } from './records'
import type { ChildProvider, WorkflowResult, WorkflowRun } from './types'

// ── workflow ───────────────────────────────────────────────────────────

/** The script-authoring contract (dsh-tool-workflow DESCRIPTION, verbatim). */
export const WORKFLOW_DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

The workflow's identity rides the \`meta\` parameter as JSON: required \`name\` (short kebab-case) and \`description\` strings, optional \`whenToUse\` string and \`phases\` array (\`{title, detail?, provider?, model?}\`). The \`script\` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO \`export const meta\` statement — meta is a parameter, not code), running with top-level await; end with \`return <value>\` — the value must be JSON-serializable and is this tool's result.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides (either may be provided alone). Anything else (\`effort\`/\`isolation\`/\`agentType\`) is rejected loudly.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. An ordinary stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Constraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.`

export const WORKFLOW_PROMPT_SECTION = (toolName: string): string =>
  `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`

export const DEFAULT_WORKFLOW_MAX_RESULT_CHARS = 50_000

function workflowStopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `workflow run was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`
  }
}

/** Render the run's outcome text: the meta name, agent count, and the JSON value (capped). */
export function renderWorkflowResult(
  name: string,
  agentsStarted: number,
  value: unknown,
  maxChars: number,
): string {
  const rendered = JSON.stringify(value, null, 2) ?? 'null'
  const clipped =
    rendered.length > maxChars
      ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
      : rendered
  return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`
}

const phaseInput = z
  .object({
    title: z
      .string()
      .describe('The phase title phase() calls match by exact string.'),
    detail: z
      .string()
      .optional()
      .describe('Optional one-line description of the phase.'),
    provider: z
      .string()
      .optional()
      .describe('Optional provider override this phase is expected to use.'),
    model: z
      .string()
      .optional()
      .describe('Optional model override this phase is expected to use.'),
  })
  .passthrough()

const workflowInput = z.object({
  script: z
    .string()
    .describe(
      'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).',
    ),
  meta: z
    .object({
      name: z.string().describe('Short kebab-case workflow name.'),
      description: z
        .string()
        .describe('One-line description of what the workflow does.'),
      whenToUse: z
        .string()
        .optional()
        .describe('Optional guidance on when this workflow applies.'),
      phases: z
        .array(phaseInput)
        .optional()
        .describe('Optional phase declarations matched by phase() calls.'),
    })
    .passthrough()
    .describe('The workflow identity block (plain JSON — never code).'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
    ),
})

export interface WorkflowToolDeps {
  engine: WorkflowEngine
  runs: WorkflowRunRegistry
  toolName?: string
  maxResultChars?: number
}

/**
 * Run one foreground workflow to settlement with durable recording, abort
 * bridging, and disposal on every path. Returns the settled result.
 */
async function collectRun(
  run: WorkflowRun,
  signal: AbortSignal,
  runs: WorkflowRunRegistry,
  finish: (result: WorkflowResult) => string | undefined,
): Promise<WorkflowResult> {
  const onAbort = (): void => {
    run.cancel('parent step aborted')
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) run.cancel('parent step aborted')
  let result: WorkflowResult | undefined
  let rendered: string | undefined
  try {
    result = await run.result
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      // Member listeners stay registered through disposal: the engine may
      // synthesize cancelled member endings while reaching quiescence.
      await run.dispose()
      if (result !== undefined) {
        try {
          rendered = finish(result)
        } catch {
          rendered = undefined
        }
        runs.finish(run.id, {
          stopReason: result.stopReason,
          agentsStarted: result.agentsStarted,
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(rendered === undefined ? {} : { result: rendered }),
        })
      }
    } finally {
      runs.abandon(run.id)
    }
  }
}

/** Bounded run-end record text. */
const RECORD_RESULT_CHARS = 8_000

function boundRecord(text: string): string {
  return text.length <= RECORD_RESULT_CHARS
    ? text
    : `${text.slice(0, RECORD_RESULT_CHARS)}\n… [truncated]`
}

export function createWorkflowTool(deps: WorkflowToolDeps): ToolDefinition {
  const toolName = deps.toolName ?? 'workflow'
  const maxResultChars =
    deps.maxResultChars ?? DEFAULT_WORKFLOW_MAX_RESULT_CHARS
  return defineTool({
    name: toolName,
    description: WORKFLOW_DESCRIPTION,
    input: workflowInput,
    async execute(args, context) {
      const parent = context.agent
      if (parent === undefined)
        throw new ToolError(
          'workflow tool requires a calling agent (exec.agent was undefined)',
        )
      // META_INVALID / SCRIPT_PARSE throw synchronously here → isError the model can correct.
      const run = deps.engine.start({
        script: args.script,
        meta: args.meta,
        ...(args.args === undefined ? {} : { args: args.args }),
        parent,
        callId: context.callId,
        signal: context.signal,
      })
      deps.runs.begin(run, {
        owner: parent,
        tool: 'workflow',
        callId: context.callId,
      })
      const result = await collectRun(
        run,
        context.signal,
        deps.runs,
        (settled) =>
          settled.stopReason === 'completed'
            ? boundRecord(
                renderWorkflowResult(
                  run.meta.name,
                  settled.agentsStarted,
                  settled.value,
                  maxResultChars,
                ),
              )
            : undefined,
      )
      const error = workflowStopReasonError(result)
      if (error !== undefined) throw new ToolError(error, 'WORKFLOW_FAILED')
      const text = renderWorkflowResult(
        run.meta.name,
        result.agentsStarted,
        result.value,
        maxResultChars,
      )
      const serialized = JSON.stringify(result.value) ?? 'null'
      return {
        content: text,
        meta: {
          kind: 'workflow',
          runId: run.id,
          name: run.meta.name,
          agentsStarted: result.agentsStarted,
          ...(serialized.length <= maxResultChars
            ? { result: result.value }
            : {}),
        },
      }
    },
  })
}

// ── ralph ──────────────────────────────────────────────────────────────

export interface RalphConfig {
  /** Fresh structured-output provider used for every round (default `spawn`). */
  subagentProvider?: string
  /** Default and deployment ceiling for one call's round count (dsh default 256; standard preset 64). */
  maxRounds?: number
  /** Maximum serialized characters in one structured handoff (default 16384). */
  maxHandoffChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number
}

/** The standard preset's Ralph ceiling (`agent-presets/standard`: `maxRounds: 64`). */
export const STANDARD_RALPH_MAX_ROUNDS = 64

interface ResolvedRalphConfig {
  readonly subagentProvider: string
  readonly maxRounds: number
  readonly maxHandoffChars: number
  readonly maxResultChars: number
}

type RalphRoundStatus = 'continue' | 'complete' | 'blocked'

interface RalphRoundReport {
  readonly status: RalphRoundStatus
  readonly summary: string
  readonly evidence: string[]
  readonly nextSteps: string[]
  readonly blocker: string
}

type RalphRunStatus = 'complete' | 'blocked' | 'budget-limited'

interface RalphRunResult {
  readonly status: RalphRunStatus
  readonly roundsStarted: number
  readonly report: RalphRoundReport
}

interface RalphRoundFailure {
  readonly status: 'round-failed'
  readonly roundsStarted: number
  readonly lastReport?: RalphRoundReport
}

type RalphTerminalResult = RalphRunResult | RalphRoundFailure

export const RALPH_META = {
  name: 'ralph-loop',
  description:
    'Iterate toward one objective with a fresh child and bounded structured handoff per round.',
  phases: [
    {
      title: 'Fresh-agent rounds',
      detail: 'One clean child context per Ralph round.',
    },
  ],
}

/**
 * Fixed, deployment-owned orchestration (dsh-tool-ralph, verbatim). The model
 * supplies data only; it cannot alter the loop, route, schema, or validation.
 */
export const RALPH_SCRIPT = String.raw`
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function validateReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Ralph child returned no structured round report')
  }
  if (!normalizedText(report.summary)) {
    throw new Error('Ralph round report summary must be non-empty and normalized')
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.nextSteps)) {
    throw new Error('Ralph round report evidence and nextSteps must contain only non-empty normalized strings')
  }
  if (typeof report.blocker !== 'string' || report.blocker !== report.blocker.trim()) {
    throw new Error('Ralph round report blocker must be a normalized string')
  }
  switch (report.status) {
    case 'continue':
      if (report.nextSteps.length === 0 || report.blocker !== '') {
        throw new Error('a continuing Ralph report needs nextSteps and an empty blocker')
      }
      break
    case 'complete':
      if (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== '') {
        throw new Error('a complete Ralph report needs evidence, no nextSteps, and an empty blocker')
      }
      break
    case 'blocked':
      if (!normalizedText(report.blocker)) {
        throw new Error('a blocked Ralph report needs a concrete blocker')
      }
      break
    default:
      throw new Error('Ralph round report status is invalid')
  }
  const serialized = JSON.stringify(report)
  if (serialized.length > args.maxHandoffChars) {
    throw new Error('Ralph round report exceeds maxHandoffChars (' + serialized.length + ' > ' + args.maxHandoffChars + ')')
  }
  return report
}

let previous
phase('Fresh-agent rounds')
for (let round = 1; round <= args.maxRounds; round += 1) {
  const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
  const prompt = [
    'You are one fresh worker in a foreground Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker.',
    'Immutable objective:\n' + args.objective,
    'Ralph round: ' + round + ' of ' + args.maxRounds + '.',
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace.',
    'Previous structured handoff:\n' + prior,
    'Return one report with exact normalized strings. Use status continue with at least one nextSteps entry while useful work remains; complete only with concrete evidence and no nextSteps; blocked only when no meaningful progress is possible without human input or an external-state change. blocker must be empty unless blocked.',
  ].join('\n\n')
  const rawReport = await agent(prompt, {
    label: 'Ralph round ' + round,
    phase: 'Fresh-agent rounds',
    schema: reportSchema,
  })
  if (rawReport === null) {
    return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  }
  const report = validateReport(rawReport)
  if (report.status === 'complete') return { status: 'complete', roundsStarted: round, report }
  if (report.status === 'blocked') return { status: 'blocked', roundsStarted: round, report }
  previous = report
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
`

export const RALPH_DESCRIPTION =
  'Run a foreground fresh-agent Ralph loop toward one immutable objective. ' +
  'Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round ' +
  'opens a new child with no parent conversation or prior child session; the shared workspace is ' +
  'long-term memory, and only a bounded structured report crosses rounds. The call returns when ' +
  'a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work ' +
  'belongs to goal tools.'

export const RALPH_PROMPT_SECTION =
  'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.'

/** Validate defaults (dsh `resolveConfig`). */
export function resolveRalphConfig(
  config: RalphConfig = {},
): ResolvedRalphConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxRounds = config.maxRounds ?? 256
  const maxHandoffChars = config.maxHandoffChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  if (
    subagentProvider.length === 0 ||
    subagentProvider !== subagentProvider.trim()
  )
    throw new TypeError(
      'subagentProvider must be a non-empty normalized string',
    )
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1)
    throw new TypeError('maxRounds must be a positive safe integer')
  if (!Number.isSafeInteger(maxHandoffChars) || maxHandoffChars < 1)
    throw new TypeError('maxHandoffChars must be a positive safe integer')
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1)
    throw new TypeError('maxResultChars must be a positive safe integer')
  return { subagentProvider, maxRounds, maxHandoffChars, maxResultChars }
}

function resolveMaxRounds(
  requested: number | undefined,
  ceiling: number,
): number {
  const value = requested ?? ceiling
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ToolError('Ralph maxRounds must be a positive safe integer')
  if (value > ceiling)
    throw new ToolError(
      `Ralph maxRounds ${value} exceeds the deployment ceiling ${ceiling}`,
    )
  return value
}

function requireFreshProvider(
  engine: WorkflowEngine,
  name: string,
): ChildProvider {
  const provider = engine.getProvider(name)
  if (provider === undefined)
    throw new ToolError(`Ralph subagent provider "${name}" is not registered`)
  if (!provider.capabilities.outputSchema)
    throw new ToolError(
      `Ralph subagent provider "${name}" does not support structured output`,
    )
  if (provider.inheritsParentContext)
    throw new ToolError(
      `Ralph subagent provider "${name}" inherits parent context; Ralph requires a fresh provider`,
    )
  return provider
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

function keysAre(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(',') === keys
}

/** Defensively decode the fixed script's report across the provider boundary. */
function readReport(
  value: unknown,
  expectedStatus: RalphRoundStatus,
  maxChars: number,
): RalphRoundReport {
  if (
    !isRecord(value) ||
    !keysAre(value, 'blocker,evidence,nextSteps,status,summary') ||
    value['status'] !== expectedStatus ||
    !normalizedText(value['summary']) ||
    !normalizedList(value['evidence']) ||
    !normalizedList(value['nextSteps']) ||
    typeof value['blocker'] !== 'string' ||
    value['blocker'] !== value['blocker'].trim()
  )
    throw new Error('Ralph workflow returned a malformed round report')
  const report: RalphRoundReport = {
    status: expectedStatus,
    summary: value['summary'],
    evidence: value['evidence'],
    nextSteps: value['nextSteps'],
    blocker: value['blocker'],
  }
  if (
    expectedStatus === 'continue' &&
    (report.nextSteps.length === 0 || report.blocker !== '')
  )
    throw new Error('Ralph workflow returned an invalid continuing report')
  if (
    expectedStatus === 'complete' &&
    (report.evidence.length === 0 ||
      report.nextSteps.length !== 0 ||
      report.blocker !== '')
  )
    throw new Error('Ralph workflow returned an invalid completion report')
  if (expectedStatus === 'blocked' && !normalizedText(report.blocker))
    throw new Error('Ralph workflow returned an invalid blocked report')
  const chars = JSON.stringify(report).length
  if (chars > maxChars)
    throw new Error(
      `Ralph workflow returned an oversized handoff (${chars} > ${maxChars})`,
    )
  return report
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(
  value: unknown,
  maxRounds: number,
  maxHandoffChars: number,
): RalphTerminalResult {
  const rounds = isRecord(value) ? value['roundsStarted'] : undefined
  if (
    !isRecord(value) ||
    typeof rounds !== 'number' ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    rounds > maxRounds
  )
    throw new Error('Ralph workflow returned a malformed terminal result')
  const roundsStarted = rounds
  const malformed = (): never => {
    throw new Error('Ralph workflow returned a malformed terminal result')
  }
  switch (value['status']) {
    case 'complete':
      if (!keysAre(value, 'report,roundsStarted,status')) malformed()
      return {
        status: 'complete',
        roundsStarted,
        report: readReport(value['report'], 'complete', maxHandoffChars),
      }
    case 'blocked':
      if (!keysAre(value, 'report,roundsStarted,status')) malformed()
      return {
        status: 'blocked',
        roundsStarted,
        report: readReport(value['report'], 'blocked', maxHandoffChars),
      }
    case 'budget-limited':
      if (!keysAre(value, 'report,roundsStarted,status')) malformed()
      if (roundsStarted !== maxRounds)
        throw new Error(
          'Ralph workflow returned budget-limited before the round limit',
        )
      return {
        status: 'budget-limited',
        roundsStarted,
        report: readReport(value['report'], 'continue', maxHandoffChars),
      }
    case 'round-failed': {
      if (!keysAre(value, 'lastReport,roundsStarted,status')) malformed()
      if (roundsStarted === 1) {
        if (value['lastReport'] !== null)
          throw new Error(
            'Ralph workflow returned an invalid first-round failure',
          )
        return { status: 'round-failed', roundsStarted }
      }
      if (value['lastReport'] === null)
        throw new Error(
          'Ralph workflow returned a round failure without its last handoff',
        )
      return {
        status: 'round-failed',
        roundsStarted,
        lastReport: readReport(
          value['lastReport'],
          'continue',
          maxHandoffChars,
        ),
      }
    }
    default:
      throw new Error('Ralph workflow returned an unknown terminal status')
  }
}

function ralphStopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `Ralph workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `Ralph workflow failed: ${result.error ?? 'unknown error'}`
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length)
    return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** Render the fixed terminal envelope without presenting self-report as certification. */
export function renderRalphResult(
  result: RalphRunResult,
  maxChars: number,
): string {
  const rounds = `${result.roundsStarted} round${result.roundsStarted === 1 ? '' : 's'}`
  const report = JSON.stringify(result.report, null, 2)
  let text: string
  switch (result.status) {
    case 'complete':
      text = `Ralph worker reported completion after ${rounds}.\nFinal report:\n${report}`
      break
    case 'blocked':
      text = `Ralph worker reported a blocker after ${rounds}.\nFinal report:\n${report}`
      break
    case 'budget-limited':
      text = `Ralph reached its ${rounds} limit; the worker reported work remaining.\nFinal report:\n${report}`
      break
  }
  return boundResult(text, maxChars)
}

function renderRoundFailure(
  result: RalphRoundFailure,
  maxChars: number,
): string {
  const header = `Ralph round ${result.roundsStarted} child failed before producing a structured report.`
  const text =
    result.lastReport === undefined
      ? `${header}\nNo previous handoff was available.`
      : `${header}\nLast successful handoff:\n${JSON.stringify(result.lastReport, null, 2)}`
  return boundResult(text, maxChars)
}

const ralphInput = z.object({
  objective: z
    .string()
    .describe(
      'The immutable completion objective for every fresh Ralph round.',
    ),
  maxRounds: z
    .number()
    .optional()
    .describe(
      'Optional positive safe-integer round cap, bounded by the deployment ceiling.',
    ),
})

export interface RalphToolDeps {
  engine: WorkflowEngine
  runs: WorkflowRunRegistry
  config?: RalphConfig
}

export function createRalphTool(deps: RalphToolDeps): ToolDefinition {
  const resolved = resolveRalphConfig(deps.config)
  return defineTool({
    name: 'ralph',
    description: RALPH_DESCRIPTION,
    input: ralphInput,
    async execute(args, context) {
      const parent = context.agent
      if (parent === undefined)
        throw new ToolError(
          'Ralph tool requires a calling agent (exec.agent was undefined)',
        )
      const objective = args.objective.trim()
      if (objective.length === 0)
        throw new ToolError('Ralph objective must be a non-empty string')
      const maxRounds = resolveMaxRounds(args.maxRounds, resolved.maxRounds)
      void requireFreshProvider(deps.engine, resolved.subagentProvider)
      const run = deps.engine.start({
        script: RALPH_SCRIPT,
        meta: RALPH_META,
        args: {
          objective,
          maxRounds,
          maxHandoffChars: resolved.maxHandoffChars,
        },
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: maxRounds,
        parent,
        callId: context.callId,
        signal: context.signal,
      })
      deps.runs.begin(run, {
        owner: parent,
        tool: 'ralph',
        callId: context.callId,
      })
      let decoded: RalphTerminalResult | undefined
      let decodeError: unknown
      const settled = await collectRun(
        run,
        context.signal,
        deps.runs,
        (result) => {
          if (result.stopReason !== 'completed') return undefined
          try {
            decoded = readRunResult(
              result.value,
              maxRounds,
              resolved.maxHandoffChars,
            )
          } catch (error: unknown) {
            decodeError = error
            return undefined
          }
          return decoded.status === 'round-failed'
            ? renderRoundFailure(decoded, resolved.maxResultChars)
            : renderRalphResult(decoded, resolved.maxResultChars)
        },
      )
      const error = ralphStopReasonError(settled)
      if (error !== undefined) throw new ToolError(error, 'WORKFLOW_FAILED')
      if (decodeError !== undefined) throw decodeError
      decoded ??= readRunResult(
        settled.value,
        maxRounds,
        resolved.maxHandoffChars,
      )
      if (decoded.status === 'round-failed')
        throw new ToolError(
          renderRoundFailure(decoded, resolved.maxResultChars),
          'RALPH_ROUND_FAILED',
        )
      return {
        content: renderRalphResult(decoded, resolved.maxResultChars),
        meta: {
          kind: 'ralph',
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: decoded,
        },
      }
    },
  })
}

// ── install ────────────────────────────────────────────────────────────

export interface InstallWorkflowOptions {
  engine: WorkflowEngine
  runs: WorkflowRunRegistry
  toolName?: string
  maxResultChars?: number
  ralph?: RalphConfig
}

/**
 * Register `workflow` + `ralph` and their usage-policy prompt sections, and
 * attach the durable recorder to the engine. dsh's standard preset mounts
 * both in its delegation group without a child tool filter, so they are
 * visible to every agent (depth is bounded by the subagent `maxDepth`).
 */
export function installWorkflow(
  tools: ToolRegistry,
  prompt: SystemPromptAssembler,
  options: InstallWorkflowOptions,
): () => void {
  const toolName = options.toolName ?? 'workflow'
  const disposers: Array<() => void> = [
    options.engine.observe(options.runs.observer),
    tools.register(
      createWorkflowTool({
        engine: options.engine,
        runs: options.runs,
        toolName,
        ...(options.maxResultChars === undefined
          ? {}
          : { maxResultChars: options.maxResultChars }),
      }),
    ),
    prompt.section({
      name: `tool:${toolName}`,
      order: 115,
      text: WORKFLOW_PROMPT_SECTION(toolName),
    }),
    tools.register(
      createRalphTool({
        engine: options.engine,
        runs: options.runs,
        config: options.ralph ?? { maxRounds: STANDARD_RALPH_MAX_ROUNDS },
      }),
    ),
    prompt.section({
      name: 'tool:ralph',
      order: 116,
      text: RALPH_PROMPT_SECTION,
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export type { WorkflowRunTool }
