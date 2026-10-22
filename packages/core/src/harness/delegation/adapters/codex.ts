import {
  SUBAGENT_IDENTITY,
  SUBAGENT_HANDOFF,
  EXTERNAL_REPORT_TRANSPORT,
} from '../../subagent/contract'
import { randomUUID } from 'node:crypto'
import {
  DelegationError,
  type ExecutorAdapter,
  type ExecutorOpenInput,
  type ExecutorSession,
  type ExecutorEventPayload,
  type ExecutorTurnInput,
  type NormalizedExecutorEvent,
} from '../types'
import { ManagedAgentProcess, type ManagedProcessHandle } from '../process'
import { CodexRpc, type CodexRpcOptions, type RpcId } from './codex-rpc'
import { AsyncQueue } from './async-queue'
import { redactExecutorText } from '../redaction'
import { jsonSchema } from '../../tools/json-schema'
import { publicReferences } from '../facts'
import { codexUserAgentIssue } from '../compatibility'
import {
  DEVELOPMENT_ENVIRONMENT_KEYS,
  projectInstructions,
} from '../dev-environment'
import {
  acquireCodexAuth,
  CODEX_FILE_CREDENTIALS,
  type CodexAuthLease,
} from '../codex-auth'
import {
  codexModelRows,
  replacementModel,
  type OfferedModel,
} from '../model-choice'
/** History pages stay well under the 4 MiB protocol frame limit. */
const HISTORY_PAGE_BYTES = 1024 * 1024
const HISTORY_TURNS = 20
/** How long a run waits for Codex to list the login's models (FIX-16). */
const MODEL_LIST_TIMEOUT_MS = 8000
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
const disabledFeatures = [
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'remote_plugin',
  'goals',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'in_app_chat',
  'in_app_local_automation',
  'hooks',
  'memories',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'recommended_plugins',
  'tool_suggest',
  'sleep_tool',
  'shell_snapshot',
  'shell_snapshot_v2',
  // On by default since Codex 0.163 (AGT-13). Codex 0.153 does not know
  // eight of them and ignores them without a warning, so both get the list.
  // A shared app-server daemon could outlive the run and Emperor.
  'daemon_auto_start',
  // Emperor owns workspaces and their leases; Codex makes no worktrees.
  'worktrees',
  // Voice, realtime and browser annotation: never needed headless.
  'realtime_conversation',
  'in_app_voice',
  'browser_annotation_api',
  // A speed tier: Emperor never chooses one, so none may apply itself.
  'ultrafast_mode',
  // Daybreak, a per-thread mode with its own models.
  'cli_daybreak',
  // Commands on a pseudo-terminal get their own session, outside the
  // process group Emperor stops; 0.153 ran them without one.
  'unified_exec_tty',
  // A new approval path; Emperor's runs ask for no approvals.
  'write_stdin_approval',
  // Under development; changes how an interrupt ends a turn.
  'instant_interrupt',
]
/**
 * The Codex features Emperor sets for every app-server it starts (runs and
 * the model list): name → on. Every other feature keeps Codex's default;
 * what that leaves on is pinned per protocol in codex-contract.test.ts.
 */
export const CODEX_FEATURES: Readonly<Record<string, boolean>> = {
  ...Object.fromEntries(disabledFeatures.map((name) => [name, false])),
  default_mode_request_user_input: true,
  skip_host_skill_discovery: true,
  code_mode_host: true,
  standalone_web_search: true,
  image_generation: true,
}
const featureConfig = Object.fromEntries(
  Object.entries(CODEX_FEATURES).map(([name, on]) => ['features.' + name, on]),
)
/** `codex app-server` over stdio, with Emperor's features, no MCP servers, file credentials. */
export function codexAppServerArgs(): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    ...Object.entries(featureConfig).flatMap(([key, value]) => [
      '-c',
      key + '=' + String(value),
    ]),
    '-c',
    'mcp_servers={}',
    ...CODEX_FILE_CREDENTIALS,
  ]
}
export function codexThreadParams(
  input: ExecutorOpenInput,
): Record<string, unknown> {
  // Codex's shell inherits nothing: it gets the basics and the task's
  // development environment (AGT-08: git identity, proxies, SSH, toolchains).
  const shellEnvironment = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TEMP',
      'TMP',
      ...DEVELOPMENT_ENVIRONMENT_KEYS,
    ].flatMap((key) =>
      input.environment[key] ? [[key, input.environment[key]!]] : [],
    ),
  )
  const agents = projectInstructions(input.cwd, ['AGENTS.md'], 8_192)
  return {
    cwd: input.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...(input.profile.defaultModel
      ? { model: input.profile.defaultModel }
      : {}),
    config: {
      ...featureConfig,
      web_search: 'live',
      mcp_servers: {},
      'shell_environment_policy.inherit': 'none',
      'shell_environment_policy.set': shellEnvironment,
    },
    developerInstructions:
      [SUBAGENT_IDENTITY, SUBAGENT_HANDOFF, EXTERNAL_REPORT_TRANSPORT].join(
        '\n\n',
      ) +
      '\n\n' +
      'The host OS enforces your workspace permission boundary. ' +
      (input.policy.mode === 'read-only'
        ? 'The source workspace is readonly; review only.'
        : 'Deliver changes as files. Do not commit or change Git metadata.') +
      (agents ? `\n\n${agents}` : ''),
  }
}
/** One `TokenUsageBreakdown` of `thread/tokenUsage/updated`. */
interface CodexTokenBreakdown {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
}
function breakdown(value: unknown): CodexTokenBreakdown | undefined {
  const r = record(value)
  const n = (key: string) =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) ? r[key] : undefined
  const input = n('inputTokens'),
    output = n('outputTokens')
  if (input === undefined || output === undefined) return undefined
  const cached = n('cachedInputTokens') ?? 0,
    reasoning = n('reasoningOutputTokens') ?? 0
  return {
    input,
    cached,
    output,
    reasoning,
    total: n('totalTokens') ?? input + output,
  }
}
/**
 * A run's tokens from the thread totals (AGT-07). `last` is the latest
 * model request and `total` the thread's sum, so the run is the latest
 * total minus the total before its first request (first total − first
 * last); a repeated update adds nothing. Counts follow the ledger: input
 * without cache reads, output with reasoning.
 */
export function createCodexUsageMeter(): {
  update(tokenUsage: unknown): ExecutorEventPayload | undefined
} {
  let base: CodexTokenBreakdown | undefined
  return {
    update(tokenUsage) {
      const usage = record(tokenUsage)
      const total = breakdown(usage.total)
      if (!total) return undefined
      if (!base) {
        const last = breakdown(usage.last) ?? total
        base = {
          input: total.input - last.input,
          cached: total.cached - last.cached,
          output: total.output - last.output,
          reasoning: total.reasoning - last.reasoning,
          total: total.total - last.total,
        }
      }
      const d = (key: keyof CodexTokenBreakdown) =>
        Math.max(0, total[key] - base![key])
      const cached = d('cached')
      return {
        type: 'usage',
        inputTokens: Math.max(0, d('input') - cached),
        cacheReadTokens: cached,
        outputTokens: d('output'),
        reasoningTokens: d('reasoning'),
        totalTokens: d('total'),
      }
    },
  }
}
/**
 * A turn's answer from its agent messages, in order (AGT-13). Codex 0.163
 * can split the answer into `partial_answer` messages — answer text that
 * more output or tools may follow (MessagePhase) — before its last message;
 * commentary is not part of it. Without partial answers (0.153 has no such
 * phase) the answer is the last message, as before.
 */
export function codexAnswerText(
  messages: readonly { text: string; phase?: unknown }[],
): string | undefined {
  const last = messages.at(-1)
  if (!last) return undefined
  return [
    ...messages.slice(0, -1).filter((m) => m.phase === 'partial_answer'),
    last,
  ]
    .map((m) => m.text)
    .join('\n\n')
}
/**
 * The partial answers so far and the latest message, within `limit`
 * characters: the latest message is kept whole first.
 */
function boundedAnswer(partial: string, latest: string, limit: number) {
  if (!partial) return latest.slice(0, limit)
  const room = limit - latest.length - 2
  return room > 0
    ? partial.slice(0, room) + '\n\n' + latest
    : latest.slice(0, limit)
}
export function normalizeCodexNotification(
  method: string,
  params: Record<string, unknown>,
  meter?: ReturnType<typeof createCodexUsageMeter>,
  /** A structured-output turn is parsed from its last message only. */
  options: { lastMessageOnly?: boolean } = {},
): ExecutorEventPayload[] {
  if (method === 'model/rerouted' && typeof params.toModel === 'string')
    return [
      {
        type: 'runtime_metadata',
        source: 'model-rerouted',
        model: params.toModel,
      },
    ]
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string')
    return [{ type: 'text_delta', text: params.delta }]
  if (method === 'thread/tokenUsage/updated' && meter) {
    const event = meter.update(params.tokenUsage)
    return event ? [event] : []
  }
  if (method === 'thread/tokenUsage/updated') {
    const last = record(record(params.tokenUsage).last)
    return [
      {
        type: 'usage',
        ...(typeof last.inputTokens === 'number'
          ? { inputTokens: last.inputTokens }
          : {}),
        ...(typeof last.outputTokens === 'number'
          ? { outputTokens: last.outputTokens }
          : {}),
      },
    ]
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = record(params.item),
      id = string(item.id),
      name = string(item.type)
    if (name?.startsWith('collabAgent'))
      return [
        {
          type: 'transport_error',
          code: 'EXECUTOR_INCOMPATIBLE',
          message: 'Codex native delegation was not disabled',
        },
      ]
    if (
      !id ||
      !name ||
      ![
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'dynamicToolCall',
        'webSearch',
        'imageGeneration',
        'computerUse',
      ].includes(name)
    )
      return []
    if (method === 'item/started')
      return [
        {
          type: 'tool_started',
          id,
          name,
          ...(typeof item.command === 'string'
            ? { detail: item.command.slice(0, 4096) }
            : {}),
        },
      ]
    const status =
      typeof item.exitCode === 'number' && item.exitCode !== 0
        ? 'failed'
        : (string(item.status) ?? 'completed')
    return [
      {
        type: 'tool_finished',
        id,
        status,
        ...(name === 'webSearch'
          ? {
              evidence: {
                kind: 'search' as const,
                action: codexFetchItem(item)
                  ? ('fetch' as const)
                  : ('search' as const),
                ...codexSearchResult(item),
                searchMode: 'live' as const,
              },
            }
          : {}),
        ...(name === 'imageGeneration'
          ? {
              evidence: {
                kind: 'image-generation' as const,
                action: 'generate' as const,
                success: status === 'completed' && !item.failure,
                ...(typeof item.savedPath === 'string'
                  ? { artifactPath: item.savedPath }
                  : {}),
              },
            }
          : {}),
      },
    ]
  }
  if (method === 'turn/completed') {
    const turn = record(params.turn),
      status = turn.status
    if (!['completed', 'interrupted', 'failed'].includes(String(status)))
      return [
        {
          type: 'transport_error',
          code: 'PROTOCOL_INVALID',
          message: 'Codex terminal notification has invalid status',
        },
      ]
    const messages = (Array.isArray(turn.items) ? turn.items : [])
      .map(record)
      .filter((i) => i.type === 'agentMessage' && typeof i.text === 'string')
      .map((i) => ({ text: i.text as string, phase: i.phase }))
    const text = codexAnswerText(
      options.lastMessageOnly ? messages.slice(-1) : messages,
    )
    const error = string(record(turn.error).message)
    return [
      {
        type: 'turn_finished',
        status: status as 'completed' | 'interrupted' | 'failed',
        ...(text === undefined ? {} : { text }),
        ...(error === undefined ? {} : { error: error.slice(0, 4096) }),
      },
    ]
  }
  return []
}
// Pinned standalone_web_search publishes page metadata rather than an HTTP
// body. This exact shape was observed with native web.run.open in CLI 0.153.4.
function standalonePage(r: Record<string, unknown>) {
  return (
    r.type === 'text_result' &&
    typeof r.ref_id === 'string' &&
    /^turn\d+view\d+$/.test(r.ref_id) &&
    typeof r.snippet === 'string' &&
    /^Total lines: [1-9]\d*$/.test(r.snippet) &&
    typeof r.title === 'string' &&
    r.title.trim().length > 0 &&
    publicReferences([r.url]).length > 0
  )
}
function codexFetchItem(item: Record<string, unknown>) {
  const action = record(item.action).type
  return (
    ['openPage', 'findInPage'].includes(String(action)) ||
    (action === 'other' &&
      item.query === '' &&
      Array.isArray(item.results) &&
      item.results.some((r) => standalonePage(record(r))))
  )
}
function codexSearchResult(item: Record<string, unknown>) {
  const fetch = codexFetchItem(item)
  const rows = (Array.isArray(item.results) ? item.results : []).map(record)
  const hasBody = (r: Record<string, unknown>) =>
    [r.text, r.content, r.result, r.markdown].some(
      (v) => typeof v === 'string' && v.trim().length > 0,
    )
  const failed =
    !!item.error ||
    ['failed', 'error', 'denied'].includes(String(item.status)) ||
    rows.some(
      (r) =>
        r.error ||
        ['failed', 'error', 'denied'].includes(String(r.status)) ||
        Number(r.code ?? r.statusCode ?? 0) >= 400,
    )
  // Opaque text may itself be an error. Only a structured HTTP response proves
  // page retrieval; the requested URL is not evidence of a returned page.
  const affirmative = rows.some((r) =>
    fetch
      ? standalonePage(r) ||
        (typeof (r.code ?? r.statusCode) === 'number' &&
          Number(r.code ?? r.statusCode) >= 200 &&
          Number(r.code ?? r.statusCode) < 300 &&
          hasBody(r) &&
          publicReferences([r.url]).length > 0)
      : record(item.action).type === 'search' &&
        typeof r.title === 'string' &&
        r.title.length > 0 &&
        publicReferences([r.url]).length > 0,
  )
  return {
    verified: failed || affirmative,
    success: !failed && affirmative,
    references: affirmative ? publicReferences(rows.map((r) => r.url)) : [],
  }
}
type CodexTransport = Pick<
  CodexRpc,
  'request' | 'notify' | 'respond' | 'reject' | 'close'
> &
  Partial<Pick<CodexRpc, 'hold'>>
export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly backend = 'codex' as const
  private readonly processes: ManagedAgentProcess
  constructor(
    private readonly options: {
      processes?: ManagedAgentProcess
      rpc?: (options: CodexRpcOptions) => CodexTransport
    } = {},
  ) {
    this.processes = options.processes ?? new ManagedAgentProcess()
  }
  async inspect(
    input: ExecutorOpenInput,
  ): Promise<import('../types').NativeSessionInspection> {
    if (!input.resumeSessionId)
      throw new DelegationError(
        'PROVIDER_SESSION_MISSING',
        'history inspection needs an existing thread',
      )
    const session = await this.open(input)
    let history: import('../types').NativeSessionInspection | undefined,
      error: unknown
    try {
      history = await session.inspect!()
    } catch (cause) {
      error = cause
    }
    const exit = await session.close()
    if (!exit.quiescent)
      throw new DelegationError(
        'OUTCOME_UNKNOWN',
        'inspection process stop is unproved',
      )
    if (error) throw error
    return history!
  }
  async open(input: ExecutorOpenInput): Promise<ExecutorSession> {
    const events = new AsyncQueue<NormalizedExecutorEvent>(),
      pending = new Map<string, { rpcId: RpcId; questions: string[] }>()
    let handle: ManagedProcessHandle | undefined,
      rpc: CodexTransport | undefined,
      authLease: CodexAuthLease | undefined,
      releaseTurn: (() => void) | undefined,
      providerSessionId = '',
      active: ExecutorTurnInput | undefined,
      providerTurnId: string | undefined,
      closed = false,
      summary = '',
      /** This turn's `partial_answer` messages so far (AGT-13). */
      partialAnswer = '',
      startFailure: DelegationError | undefined,
      /** The model the thread reports: Codex's own default, or Emperor's. */
      threadModel: string | undefined,
      /** The model a turn asks for instead (FIX-16). */
      turnModel: string | undefined
    let closePromise: Promise<{ quiescent: boolean }> | undefined
    // One session is one run: its tokens count from the thread totals.
    const meter = createCodexUsageMeter()
    let runtimeMetadata: Extract<
      ExecutorEventPayload,
      { type: 'runtime_metadata' }
    > = {
      type: 'runtime_metadata',
      source: 'thread-configuration',
      searchMode: 'live',
    }
    const earlyNotifications: [string, Record<string, unknown>][] = []
    const earlyRequests: [RpcId, string, Record<string, unknown>][] = []
    let earlyBytes = 0
    const emit = (payload: ExecutorEventPayload) => {
      if (!active || closed) return
      const clean = JSON.parse(
        redactExecutorText(JSON.stringify(payload), input.secretValues ?? []),
      ) as ExecutorEventPayload
      events.push({
        ...clean,
        delegationId: input.delegationId,
        runId: active.runId,
        generation: input.generation,
      })
    }
    const close = (): Promise<{ quiescent: boolean }> => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closed = true
        releaseTurn?.()
        if (rpc) {
          await Promise.allSettled(
            [...pending.values()].map((p) =>
              rpc!.reject(
                p.rpcId,
                -32000,
                'Delegation stopped',
                input.generation,
              ),
            ),
          )
          pending.clear()
          rpc.close()
        }
        let quiescent = false
        if (handle) {
          try {
            if (
              handle.child.exitCode === null &&
              handle.child.signalCode === null
            )
              await handle.terminate()
            quiescent = (await handle.closed).quiescent
          } catch {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              quiescent = (
                await Promise.race([
                  handle.closed,
                  new Promise<{ quiescent: boolean }>((resolve) => {
                    timer = setTimeout(
                      () => resolve({ quiescent: false }),
                      2500,
                    )
                  }),
                ])
              ).quiescent
            } finally {
              if (timer) clearTimeout(timer)
            }
          }
        }
        events.end()
        // Only after the process is gone may another one refresh the login.
        if (authLease)
          try {
            await authLease.release()
          } catch {
            /* The lock file is reclaimed once this process ends. */
          }
        return { quiescent }
      })()
      return closePromise
    }
    const notification = (method: string, params: Record<string, unknown>) => {
      if (!active || closed) return
      if (params.threadId !== providerSessionId) return
      const turn = record(params.turn),
        turnId = string(params.turnId) ?? string(turn.id)
      if (!providerTurnId && turnId) {
        earlyBytes += Buffer.byteLength(JSON.stringify(params))
        if (earlyNotifications.length >= 256 || earlyBytes > 4 * 1024 * 1024)
          throw new DelegationError(
            'OUTPUT_LIMIT',
            'Codex notifications before acceptance exceeded limit',
          )
        earlyNotifications.push([method, params])
        return
      }
      if (turnId && providerTurnId && turnId !== providerTurnId) return
      if (method === 'turn/started') return
      if (method === 'item/completed') {
        const item = record(params.item)
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          if (active.outputSchema) summary = item.text.slice(0, 4 * 1024 * 1024)
          else {
            summary = boundedAnswer(partialAnswer, item.text, 8192)
            if (item.phase === 'partial_answer')
              partialAnswer = boundedAnswer(partialAnswer, item.text, 8192)
          }
        }
      }
      for (let event of normalizeCodexNotification(method, params, meter, {
        lastMessageOnly: !!active.outputSchema,
      })) {
        if (event.type === 'text_delta')
          summary = (summary + event.text).slice(
            0,
            active.outputSchema ? 4 * 1024 * 1024 : 8192,
          )
        if (event.type === 'turn_finished') {
          releaseTurn?.()
          event = { ...event, text: event.text ?? summary }
          if (active.outputSchema && event.status === 'completed') {
            let structured: unknown
            try {
              structured = JSON.parse(event.text ?? '')
            } catch {
              /* Invalid schema output is a failed turn. */
            }
            if (
              jsonSchema.validateJsonSchemaValue(
                active.outputSchema,
                structured,
              ).length
            )
              event = {
                type: 'turn_finished',
                status: 'failed',
                error: 'STRUCTURED_OUTPUT_INVALID',
              }
            else event = { ...event, structured }
          }
        }
        emit(event)
      }
    }
    const serverRequest = async (
      id: RpcId,
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (!rpc) return
      if (closed) {
        await rpc.reject(id, -32000, 'Delegation closed', input.generation)
        return
      }
      if (
        ![
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
          'item/tool/requestUserInput',
        ].includes(method)
      ) {
        await rpc.reject(
          id,
          -32601,
          'Unsupported server request',
          input.generation,
        )
        emit({
          type: 'permission_denied',
          reason: 'Unknown Codex server request rejected: ' + method,
        })
        return
      }
      if (active && params.threadId === providerSessionId && !providerTurnId) {
        if (earlyRequests.length >= 64) {
          await rpc.reject(
            id,
            -32000,
            'Pending request limit reached',
            input.generation,
          )
          return
        }
        earlyRequests.push([id, method, params])
        return
      }
      if (
        !active ||
        params.threadId !== providerSessionId ||
        params.turnId !== providerTurnId
      ) {
        await rpc.reject(id, -32001, 'Stale thread or turn', input.generation)
        return
      }
      if (method === 'item/tool/requestUserInput') {
        const questions = (
          Array.isArray(params.questions) ? params.questions : []
        ).map(record)
        if (
          !questions.length ||
          questions.length > 10 ||
          questions.some(
            (q) => typeof q.id !== 'string' || typeof q.question !== 'string',
          )
        ) {
          await rpc.reject(
            id,
            -32602,
            'Unsupported question payload',
            input.generation,
          )
          return
        }
        const requestId = 'dqi-' + randomUUID()
        pending.set(requestId, {
          rpcId: id,
          questions: questions.map((q) => q.id as string),
        })
        emit({
          type: 'question',
          requestId,
          questions: questions.map((q) => ({
            id: q.id as string,
            title: q.question as string,
            ...(Array.isArray(q.options)
              ? {
                  options: q.options
                    .map(record)
                    .map((o) => String(o.label ?? ''))
                    .filter(Boolean),
                }
              : {}),
          })),
        })
        return
      }
      emit({
        type: 'permission_denied',
        reason: 'Codex requested a permission outside the delegated policy',
      })
      if (method === 'item/permissions/requestApproval')
        await rpc.respond(
          id,
          { permissions: {}, scope: 'turn' },
          input.generation,
        )
      else await rpc.respond(id, { decision: 'decline' }, input.generation)
    }
    try {
      const args = codexAppServerArgs()
      // One isolated Codex process per login at a time: it may refresh the
      // shared token (codex-auth.ts).
      if (input.codexAuth)
        authLease = await acquireCodexAuth(input.codexAuth, {
          signal: input.signal,
        })
      handle = this.processes.spawn({
        executable: input.profile.executablePath,
        args,
        cwd: input.cwd,
        env: input.environment,
        policy: input.policy,
        signal: input.signal,
        secretValues: input.secretValues,
        onSpawn: input.onProcessStarted,
        onExit: input.onProcessExit,
      })
      await handle.started
      const options: CodexRpcOptions = {
        input: handle.stdout,
        output: handle.stdin,
        generation: input.generation,
        secretValues: input.secretValues,
        onNotification: notification,
        onRequest: serverRequest,
        onClose: (error) => {
          if (closed) return
          startFailure =
            error instanceof DelegationError
              ? error
              : new DelegationError('CONNECTION_LOST', 'Codex connection lost')
          emit({
            type: 'transport_error',
            code: startFailure.code,
            message: startFailure.message,
          })
          events.end()
        },
      }
      rpc = this.options.rpc ? this.options.rpc(options) : new CodexRpc(options)
      const initialized = await rpc.request(
        'initialize',
        {
          clientInfo: { name: 'emperor-agent', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
        input.signal,
      )
      // The preflight compared the protocol digest; here the running
      // process must still be a supported minor (AGT-01).
      const incompatible = codexUserAgentIssue(initialized.userAgent)
      if (incompatible)
        throw new DelegationError('EXECUTOR_INCOMPATIBLE', incompatible)
      await rpc.notify('initialized')
      const params = codexThreadParams(input)
      const response = await rpc.request(
        input.resumeSessionId ? 'thread/resume' : 'thread/start',
        {
          ...params,
          // A resumed thread's history can outgrow the 4 MiB frame limit;
          // inspect pages it with thread/turns/list instead.
          ...(input.resumeSessionId
            ? { threadId: input.resumeSessionId, excludeTurns: true }
            : {}),
        },
        input.signal,
      )
      const thread = record(response.thread)
      if (typeof thread.id !== 'string' || !thread.id)
        throw new DelegationError(
          'PROTOCOL_INVALID',
          'Codex thread response has no identity',
        )
      if (input.resumeSessionId && thread.id !== input.resumeSessionId)
        throw new DelegationError(
          'PROVIDER_SESSION_CHANGED',
          'Codex resumed a different thread',
        )
      providerSessionId = thread.id
      threadModel = string(response.model)
      runtimeMetadata = {
        type: 'runtime_metadata',
        source: 'thread-configuration',
        ...(typeof response.model === 'string'
          ? { model: response.model }
          : {}),
        ...(typeof response.modelProvider === 'string'
          ? { provider: response.modelProvider }
          : {}),
        searchMode: 'live',
      }
    } catch (error) {
      const receipt = await close()
      if (handle && !receipt.quiescent)
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'Codex startup process termination is unproven',
        )
      throw new DelegationError(
        error instanceof DelegationError ? error.code : 'EXECUTOR_START_FAILED',
        redactExecutorText(
          error instanceof Error
            ? error.message
            : handle?.diagnostics() || 'Codex startup failed',
          input.secretValues ?? [],
        ).slice(0, 4096),
      )
    }
    /**
     * The models this login offers (`model/list`, hidden ones too: they
     * still run), from this run's own Codex process. Undefined when Codex
     * cannot say within {@link MODEL_LIST_TIMEOUT_MS} (FIX-16).
     */
    const offeredModels = async (): Promise<OfferedModel[] | undefined> => {
      const controller = new AbortController()
      const stop = () => controller.abort()
      input.signal.addEventListener('abort', stop, { once: true })
      const timer = setTimeout(stop, MODEL_LIST_TIMEOUT_MS)
      timer.unref()
      try {
        const rows: OfferedModel[] = [],
          cursors = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 8; page++) {
          const result = await rpc!.request(
            'model/list',
            { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
            controller.signal,
          )
          rows.push(...codexModelRows(result.data))
          const next = string(result.nextCursor)
          if (!next || cursors.has(next)) break
          cursors.add(next)
          cursor = next
        }
        return rows.length ? rows : undefined
      } catch (error) {
        if (input.signal.aborted) throw error
        return undefined
      } finally {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', stop)
      }
    }
    /** `turn/start` for the active turn, then its buffered notifications. */
    const startTurn = async (turn: ExecutorTurnInput): Promise<string> => {
      const response = await rpc!.request(
        'turn/start',
        {
          threadId: providerSessionId,
          clientUserMessageId: turn.messageId,
          input: [{ type: 'text', text: turn.text, text_elements: [] }],
          cwd: input.cwd,
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'externalSandbox',
            networkAccess: 'enabled',
          },
          ...(turnModel ? { model: turnModel } : {}),
          ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
        },
        input.signal,
      )
      const turnId = string(record(response.turn).id)
      if (!turnId)
        throw new DelegationError(
          'PROTOCOL_INVALID',
          'Codex accepted turn has no id',
        )
      if (providerTurnId && providerTurnId !== turnId)
        throw new DelegationError(
          'PROTOCOL_INVALID',
          'Codex response and notification disagree on turn identity',
        )
      providerTurnId = turnId
      emit({ type: 'turn_started', turnId })
      emit(runtimeMetadata)
      for (const [method, params] of earlyNotifications.splice(0))
        notification(method, params)
      for (const [id, method, params] of earlyRequests.splice(0))
        await serverRequest(id, method, params)
      return turnId
    }
    return {
      providerSessionId,
      inspect: async () => {
        if (active)
          throw new DelegationError(
            'ACTIVE_RUN',
            'history inspection must not overlap inference',
          )
        const response = await rpc!.request('thread/read', {
          threadId: providerSessionId,
          includeTurns: false,
        })
        const thread = record(response.thread)
        if (thread.id !== providerSessionId)
          throw new DelegationError(
            'PROVIDER_SESSION_CHANGED',
            'history returned another thread',
          )
        // Newest first, in pages of at most 1 MiB: a page that is too large
        // is asked again with half as many turns.
        const newest: Record<string, unknown>[] = [],
          cursors = new Set<string>()
        let cursor: string | undefined,
          limit = 8
        for (let page = 0; page < 64 && newest.length < HISTORY_TURNS;) {
          let result: Record<string, unknown>
          try {
            result = await rpc!.request(
              'thread/turns/list',
              {
                threadId: providerSessionId,
                limit: Math.min(limit, HISTORY_TURNS - newest.length),
                sortDirection: 'desc',
                itemsView: 'summary',
                ...(cursor ? { cursor } : {}),
              },
              undefined,
              { maxResultBytes: HISTORY_PAGE_BYTES },
            )
          } catch (error) {
            if (
              error instanceof DelegationError &&
              error.code === 'OUTPUT_LIMIT' &&
              limit > 1
            ) {
              limit = Math.max(1, Math.floor(limit / 2))
              continue
            }
            // A single turn larger than a page: show what was read.
            if (
              error instanceof DelegationError &&
              error.code === 'OUTPUT_LIMIT'
            )
              break
            throw error
          }
          page++
          newest.push(
            ...(Array.isArray(result.data) ? result.data : []).map(record),
          )
          const next = string(result.nextCursor)
          if (!next || cursors.has(next)) break
          cursors.add(next)
          cursor = next
        }
        const turns = newest
          .slice(0, HISTORY_TURNS)
          .reverse()
          .map((turn) => {
            const items = Array.isArray(turn.items) ? turn.items : []
            return {
              ...(typeof turn.id === 'string' ? { id: turn.id } : {}),
              ...(typeof turn.status === 'string'
                ? { status: turn.status }
                : {}),
              text: items
                .map(record)
                .filter((item) => item.type === 'agentMessage')
                .map((item) => (typeof item.text === 'string' ? item.text : ''))
                .join('\n')
                .slice(-8192),
            }
          })
        const status = record(thread.status)
        return {
          sessionId: providerSessionId,
          nativeStatus:
            typeof status.type === 'string' ? status.type : 'unknown',
          turns,
        }
      },
      events,
      submit: async (turn) => {
        if (closed || startFailure)
          throw (
            startFailure ??
            new DelegationError('EXECUTOR_CLOSED', 'Codex process is closed')
          )
        if (active)
          throw new DelegationError(
            'ACTIVE_RUN',
            'one turn per managed Codex process',
          )
        active = turn
        // A running turn may be silent for long (a build, a question): only
        // the delegation's run limit bounds it, not the idle timer.
        releaseTurn = rpc!.hold?.()
        // Nobody in Emperor chose a model and Codex's own default is not in
        // the list its ChatGPT login offers (FIX-16): the turn asks for the
        // list's default instead. Only that login's list is the account's
        // own; with an API key or another provider a model the list leaves
        // out may still run, so only a refusal changes it (the retry
        // below). The user's ~/.codex is never written.
        if (input.codexAuth && !input.profile.defaultModel && threadModel) {
          const pick = replacementModel(
            (await offeredModels()) ?? [],
            threadModel,
          )
          if (pick) {
            turnModel = pick
            runtimeMetadata = {
              ...runtimeMetadata,
              model: pick,
              modelChoice: {
                configured: threadModel,
                used: pick,
                reason: 'default-unavailable',
              },
            }
          }
        }
        return { providerTurnId: await startTurn(turn) }
      },
      retryOnSupportedModel: async (turn, refused) => {
        if (closed || startFailure || active?.runId !== turn.runId)
          return undefined
        const current = turnModel ?? threadModel,
          configured = refused ?? current
        const pick = replacementModel(
          (await offeredModels()) ?? [],
          undefined,
          [refused, current],
        )
        if (!pick || closed) return undefined
        turnModel = pick
        runtimeMetadata = {
          ...runtimeMetadata,
          model: pick,
          ...(configured
            ? { modelChoice: { configured, used: pick, reason: 'retried' } }
            : {}),
        }
        // The same turn again, in the same thread, on the chosen model.
        providerTurnId = undefined
        summary = ''
        partialAnswer = ''
        releaseTurn = rpc!.hold?.()
        return { providerTurnId: await startTurn(turn), model: pick }
      },
      steer: async (turn) => {
        if (closed || !active || providerTurnId !== turn.providerTurnId)
          throw new DelegationError(
            'STALE_RUN',
            'steer requires exact current turn',
          )
        const response = await rpc!.request(
          'turn/steer',
          {
            threadId: providerSessionId,
            expectedTurnId: turn.providerTurnId,
            clientUserMessageId: turn.messageId,
            input: [{ type: 'text', text: turn.text, text_elements: [] }],
          },
          input.signal,
        )
        if (response.turnId !== turn.providerTurnId)
          throw new DelegationError(
            'PROTOCOL_INVALID',
            'Codex steer response has no matching turn identity',
          )
      },
      answer: async (answer) => {
        if (answer.generation !== input.generation)
          throw new DelegationError('STALE_RUN', 'question generation changed')
        const request = pending.get(answer.requestId)
        if (!request)
          throw new DelegationError(
            'REQUEST_NOT_FOUND',
            'question is no longer pending',
          )
        if (answer.kind === 'deny') {
          pending.delete(answer.requestId)
          await rpc!.reject(
            request.rpcId,
            -32000,
            answer.reason,
            input.generation,
          )
          return
        }
        const answers: Record<string, { answers: string[] }> = {}
        for (const id of request.questions) {
          const value = answer.answers[id]
          if (
            typeof value !== 'string' ||
            !value.trim() ||
            Buffer.byteLength(value) > 4096
          )
            throw new DelegationError(
              'INVALID_ANSWER',
              'each question needs a bounded text answer',
            )
          answers[id] = { answers: [value] }
        }
        pending.delete(answer.requestId)
        await rpc!.respond(request.rpcId, { answers }, input.generation)
      },
      interrupt: async (turnId) => {
        if (closed || !active || providerTurnId !== turnId)
          throw new DelegationError(
            'STALE_RUN',
            'interrupt requires exact current turn',
          )
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            rpc!.request('turn/interrupt', {
              threadId: providerSessionId,
              turnId,
            }),
            new Promise<never>((_r, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new DelegationError(
                      'INTERRUPT_TIMEOUT',
                      'Codex interrupt timed out',
                    ),
                  ),
                5000,
              )
              timer.unref()
            }),
          ])
        } catch {
          await handle!.terminate()
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
      close,
    }
  }
}
