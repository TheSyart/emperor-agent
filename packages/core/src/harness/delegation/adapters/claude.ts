import {
  SUBAGENT_IDENTITY,
  SUBAGENT_HANDOFF,
  EXTERNAL_REPORT_TRANSPORT,
} from '../../subagent/contract'
import {
  startup as sdkStartup,
  type Options,
  type WarmQuery,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, existsSync } from 'node:fs'
import { claudeModelSettings } from '../local-model-config'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_CLAUDE_MAX_TURNS,
  DelegationError,
  type ExecutorAdapter,
  type ExecutorOpenInput,
  type ExecutorSession,
  type ExecutorEventPayload,
  type ExecutorTurnInput,
  type NormalizedExecutorEvent,
} from '../types'
import { ManagedAgentProcess, type ManagedProcessHandle } from '../process'
import { redactExecutorText } from '../redaction'
import { jsonSchema } from '../../tools/json-schema'
import { AsyncQueue } from './async-queue'
import { readClaudeSessionHistory } from './claude-history'
import { CLAUDE_HOST_TOOLS, publicReferences } from '../facts'
import { claudeInitIssue } from '../compatibility'
import {
  BuiltinPluginLedger,
  isBuiltinPlugin,
  preflightClaudePlugins,
  type ReportedPlugin,
} from '../claude-builtin-plugins'
import { describeUnapprovedExtensions } from '../failure'
import { projectInstructions } from '../dev-environment'
import { findExecutable } from '../executable'
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
/**
 * Why a Claude turn failed (AGT-02), from the SDK result's subtype,
 * `terminal_reason`, `api_error_status` and text.
 */
function claudeFailureCode(m: Record<string, unknown>, text: string): string {
  const status = m.api_error_status,
    reason = m.terminal_reason
  if (m.subtype === 'error_max_turns' || reason === 'max_turns')
    return 'MAX_TURNS'
  if (
    ['prompt_too_long', 'blocking_limit', 'rapid_refill_breaker'].includes(
      reason as string,
    ) ||
    /prompt is too long|context (?:length|window)/i.test(text)
  )
    return 'CONTEXT_OVERFLOW'
  if (
    status === 402 ||
    /credit balance|billing|insufficient (?:credit|funds|quota)/i.test(text)
  )
    return 'BILLING'
  if (
    status === 401 ||
    /authenticat|api[ _-]?key|oauth token|\/login/i.test(text)
  )
    return 'AUTH_EXPIRED'
  if (status === 429 || /rate[ _]limit|usage limit|\b429\b/i.test(text))
    return 'RATE_LIMITED'
  return 'EXECUTOR_TURN_FAILED'
}
export function normalizeClaudeMessage(
  raw: unknown,
  includeAssistantText = true,
  toolCalls = new Map<string, { name: string; url?: string }>(),
): ExecutorEventPayload[] {
  const m = record(raw),
    events: ExecutorEventPayload[] = []
  if (
    m.type === 'system' &&
    m.subtype === 'init' &&
    typeof m.session_id === 'string'
  )
    return [
      { type: 'session_bound', sessionId: m.session_id },
      {
        type: 'runtime_metadata',
        source: 'initialization',
        ...(typeof m.model === 'string' ? { model: m.model } : {}),
        ...(Array.isArray(m.tools)
          ? {
              advertisedTools: m.tools.filter(
                (t): t is string => typeof t === 'string',
              ),
            }
          : {}),
      },
    ]
  if (m.type === 'stream_event') {
    const e = record(m.event),
      delta = record(e.delta),
      block = record(e.content_block)
    if (
      e.type === 'content_block_delta' &&
      delta.type === 'text_delta' &&
      typeof delta.text === 'string'
    )
      events.push({ type: 'text_delta', text: delta.text })
    if (
      e.type === 'content_block_start' &&
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolCalls.set(block.id, { name: block.name })
      events.push({ type: 'tool_started', id: block.id, name: block.name })
    }
  }
  if (m.type === 'assistant' || m.type === 'user') {
    if (m.type === 'assistant' && typeof record(m.message).model === 'string')
      events.push({
        type: 'runtime_metadata',
        source: 'provider-response',
        model: record(m.message).model as string,
      })
    const content = record(m.message).content
    if (Array.isArray(content))
      for (const value of content) {
        const b = record(value)
        if (
          b.type === 'tool_use' &&
          typeof b.id === 'string' &&
          typeof b.name === 'string'
        ) {
          toolCalls.set(b.id, {
            name: b.name,
            ...(typeof record(b.input).url === 'string'
              ? { url: record(b.input).url as string }
              : {}),
          })
          events.push({ type: 'tool_started', id: b.id, name: b.name })
        }
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string')
          events.push({
            type: 'tool_finished',
            id: b.tool_use_id,
            status: b.is_error ? 'failed' : 'completed',
            ...(() => {
              const call = toolCalls.get(String(b.tool_use_id))
              if (!call || !['WebSearch', 'WebFetch'].includes(call.name))
                return {}
              const output = record(m.tool_use_result)
              const hits = (
                Array.isArray(output.results) ? output.results : []
              ).flatMap((r) =>
                Array.isArray(record(r).content)
                  ? (record(r).content as unknown[]).map(record)
                  : [],
              )
              const searchRefs = publicReferences(
                hits
                  .filter(
                    (h) => typeof h.title === 'string' && h.title.length > 0,
                  )
                  .map((h) => h.url),
              )
              const fetchShape =
                typeof output.code === 'number' &&
                typeof output.bytes === 'number' &&
                typeof output.result === 'string'
              const verified =
                call.name === 'WebFetch'
                  ? fetchShape
                  : Array.isArray(output.results) || b.is_error === true
              const success =
                b.is_error !== true &&
                (call.name === 'WebFetch'
                  ? fetchShape &&
                    Number(output.code) >= 200 &&
                    Number(output.code) < 300 &&
                    Number(output.bytes) > 0 &&
                    String(output.result).trim().length > 0
                  : searchRefs.length > 0)
              return {
                evidence: {
                  kind: 'search' as const,
                  action:
                    call.name === 'WebFetch'
                      ? ('fetch' as const)
                      : ('search' as const),
                  success,
                  verified,
                  references:
                    call.name === 'WebSearch'
                      ? searchRefs
                      : success
                        ? publicReferences([output.url])
                        : [],
                  searchMode: 'live' as const,
                },
              }
            })(),
          })
        if (
          m.type === 'assistant' &&
          includeAssistantText &&
          b.type === 'text' &&
          typeof b.text === 'string'
        )
          events.push({ type: 'text_delta', text: b.text })
      }
  }
  if (m.type === 'result') {
    const usage = record(m.usage)
    const inputTokens =
        typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
      outputTokens =
        typeof usage.output_tokens === 'number'
          ? usage.output_tokens
          : undefined
    const knownPrice = !Object.values(record(m.modelUsage)).some(
      (v) => record(v).costBasis === 'unknown',
    )
    events.push({
      type: 'usage',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(knownPrice && typeof m.total_cost_usd === 'number'
        ? { estimatedUsd: m.total_cost_usd }
        : {}),
    })
    const structured = m.structured_output
    if (
      structured !== undefined &&
      (!structured ||
        typeof structured !== 'object' ||
        Array.isArray(structured))
    )
      return [
        ...events,
        {
          type: 'turn_finished',
          status: 'failed',
          error: 'STRUCTURED_OUTPUT_INVALID',
        },
      ]
    if (m.subtype === 'success' && !m.is_error)
      events.push({
        type: 'turn_finished',
        status: 'completed',
        ...(typeof m.result === 'string' ? { text: m.result } : {}),
        ...(structured === undefined ? {} : { structured }),
      })
    else {
      const text = [
        ...(typeof m.result === 'string' ? [m.result] : []),
        ...(Array.isArray(m.errors)
          ? m.errors.filter((x) => typeof x === 'string')
          : []),
      ]
        .join('; ')
        .slice(0, 4096)
      events.push({
        type: 'turn_finished',
        status: 'failed',
        error: text || 'Claude execution failed',
        failureCode: claudeFailureCode(m, text),
      })
    }
  }
  return events
}
/**
 * What system/init says the claude loaded beyond what Emperor allows, as
 * the run's Chinese reason (VER-02), or undefined.
 */
function initExtensions(raw: Record<string, unknown>): string | undefined {
  const servers = (Array.isArray(raw.mcp_servers) ? raw.mcp_servers : []).map(
    (s) => String(record(s).name ?? s),
  )
  if (servers.length)
    return describeUnapprovedExtensions({ kind: 'mcp', servers })
  const plugins = (Array.isArray(raw.plugins) ? raw.plugins : []).map(
    (p): ReportedPlugin => {
      const r = record(p)
      return {
        name: String(r.name),
        path: String(r.path),
        ...(typeof r.source === 'string' ? { source: r.source } : {}),
      }
    },
  )
  if (!plugins.length) return undefined
  const claudeVersion =
    typeof raw.claude_code_version === 'string'
      ? raw.claude_code_version
      : undefined
  const foreign = plugins.filter((p) => !isBuiltinPlugin(p))
  return foreign.length
    ? describeUnapprovedExtensions({
        kind: 'foreign',
        claudeVersion,
        plugins: foreign,
      })
    : describeUnapprovedExtensions({
        kind: 'stuck',
        claudeVersion,
        plugins: plugins.map((p) => p.source!),
      })
}
const tools = CLAUDE_HOST_TOOLS
const forbidden = [
  'Agent',
  'Task',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
]
export class ClaudeExecutorAdapter implements ExecutorAdapter {
  readonly backend = 'claude-code' as const
  private readonly processes: ManagedAgentProcess
  private readonly ledger: BuiltinPluginLedger
  constructor(
    private readonly options: {
      processes?: ManagedAgentProcess
      startup?: (
        options: Options,
      ) => Promise<Pick<WarmQuery, 'query' | 'close'>>
      /** Test hook: the SDK entry the history reader imports. */
      sdkUrl?: () => string
      /**
       * Claude Code's own plugins, turned off (VER-02); the composition
       * root keeps it in `<delegations>/claude-code/`. Default: the seed.
       */
      ledger?: BuiltinPluginLedger
      /** Each control request of the plugin preflight (default 5 s). */
      preflightTimeoutMs?: number
    } = {},
  ) {
    this.processes = options.processes ?? new ManagedAgentProcess()
    this.ledger = options.ledger ?? new BuiltinPluginLedger()
  }
  async inspect(
    input: ExecutorOpenInput,
  ): Promise<import('../types').NativeSessionInspection> {
    if (!input.resumeSessionId)
      throw new DelegationError(
        'PROVIDER_SESSION_MISSING',
        'history inspection needs an existing Claude session',
      )
    // The SDK's session reader takes its config directory from the
    // environment; a worker gives it the delegation's (claude-history.ts).
    return await readClaudeSessionHistory({
      sdkUrl: (
        this.options.sdkUrl ??
        (() => import.meta.resolve('@anthropic-ai/claude-agent-sdk'))
      )(),
      sessionId: input.resumeSessionId,
      cwd: input.cwd,
      env: input.environment,
      signal: input.signal,
    })
  }
  async open(input: ExecutorOpenInput): Promise<ExecutorSession> {
    const providerSessionId = input.resumeSessionId ?? randomUUID()
    const prompts = new AsyncQueue<SDKUserMessage>(),
      events = new AsyncQueue<NormalizedExecutorEvent>()
    let handle: ManagedProcessHandle | undefined,
      warm: Pick<WarmQuery, 'query' | 'close'> | undefined,
      query: Query | undefined,
      active: ExecutorTurnInput | undefined,
      initialized = false,
      closed = false,
      interrupted = false,
      startFailure: DelegationError | undefined
    let acknowledge: (value: { providerTurnId: string }) => void = () =>
        undefined,
      rejectSubmit: (reason: unknown) => void = () => undefined
    let closePromise: Promise<{ quiescent: boolean }> | undefined
    const pending = new Map<
      string,
      {
        resolve: (result: PermissionResult) => void
        raw: Record<string, unknown>
        questions: { question: string; id: string }[]
      }
    >()
    const emit = (payload: ExecutorEventPayload) => {
      if (!active || closed) return
      const sanitized = JSON.parse(
        redactExecutorText(JSON.stringify(payload), input.secretValues ?? []),
      ) as ExecutorEventPayload
      events.push({
        ...sanitized,
        delegationId: input.delegationId,
        runId: active.runId,
        generation: input.generation,
      })
    }
    const deny = (reason: string): PermissionResult => {
      emit({ type: 'permission_denied', reason })
      return { behavior: 'deny', message: reason }
    }
    const restriction = (
      name: string,
      args: Record<string, unknown>,
    ): string | undefined => {
      if (
        ![...tools, 'StructuredOutput'].includes(name) ||
        forbidden.includes(name) ||
        name.startsWith('mcp__')
      )
        return 'UNSUPPORTED_TOOL: nested agents, plugins and external MCP are disabled'
      if (args.run_in_background === true)
        return 'UNSUPPORTED_TOOL: external background jobs are disabled'
      if (['Write', 'Edit'].includes(name)) {
        if (input.policy.mode === 'read-only')
          return 'PERMISSION_DENIED: workspace is readonly'
        const path =
          typeof args.file_path === 'string'
            ? resolve(input.cwd, args.file_path)
            : undefined
        const rel = path ? relative(input.policy.workspaceRoot, path) : '..'
        if (
          input.policy.mode !== 'danger-full-access' &&
          (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
        )
          return 'PERMISSION_DENIED: path is outside the delegated workspace'
      }
      if (name === 'Bash' && input.policy.mode === 'read-only')
        return 'PERMISSION_DENIED: Bash is disabled for readonly reviews'
      return undefined
    }
    const close = (): Promise<{ quiescent: boolean }> => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closed = true
        rejectSubmit(
          new DelegationError(
            'EXECUTOR_CLOSED',
            'Claude process closed before acceptance',
          ),
        )
        for (const request of pending.values())
          request.resolve({
            behavior: 'deny',
            message: 'Delegation stopped',
            interrupt: true,
          })
        pending.clear()
        prompts.end()
        try {
          query?.close()
        } catch {
          /* The managed process receipt decides shutdown. */
        }
        try {
          warm?.close()
        } catch {
          /* The managed process receipt decides shutdown. */
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
        return { quiescent }
      })()
      return closePromise
    }
    // The user's installed, unmodified claude (AGT-12: Emperor ships none);
    // the runtime put its folder on PATH.
    const executable =
      findExecutable(input.profile.executablePath, input.environment.PATH) ??
      input.profile.executablePath
    try {
      const options: Options = {
        cwd: input.cwd,
        pathToClaudeCodeExecutable: executable,
        env: input.environment,
        settingSources: [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [
            SUBAGENT_IDENTITY,
            SUBAGENT_HANDOFF,
            EXTERNAL_REPORT_TRANSPORT,
            // The repository's CLAUDE.md as text, not its settings: project
            // settings could pre-approve tools past canUseTool (AGT-08).
            projectInstructions(input.cwd, [
              'CLAUDE.md',
              join('.claude', 'CLAUDE.md'),
              'AGENTS.md',
            ]),
          ]
            .filter((part): part is string => Boolean(part))
            .join('\n\n'),
        },
        persistSession: true,
        includePartialMessages: true,
        ...(input.resumeSessionId
          ? { resume: input.resumeSessionId }
          : { sessionId: providerSessionId }),
        ...(input.profile.defaultModel
          ? { model: input.profile.defaultModel }
          : {}),
        ...(input.outputSchema
          ? {
              outputFormat: {
                type: 'json_schema',
                schema: { ...input.outputSchema },
              },
            }
          : {}),
        permissionMode: 'default',
        // The host's OS boundary wraps the whole process tree. Avoid a second,
        // vendor-managed shell sandbox with unrelated temp-directory grants.
        sandbox: { enabled: false },
        tools,
        allowedTools: [],
        disallowedTools: forbidden,
        settings: {
          ...(input.environment.CLAUDE_CONFIG_DIR &&
          existsSync(join(input.environment.CLAUDE_CONFIG_DIR, 'settings.json'))
            ? claudeModelSettings(
                JSON.parse(
                  readFileSync(
                    join(input.environment.CLAUDE_CONFIG_DIR, 'settings.json'),
                    'utf8',
                  ),
                ),
              )
            : {}),
          // Every builtin Emperor knows, off from launch (VER-02).
          enabledPlugins: this.ledger.enabledPluginsSetting(),
          syncClaudeAiSkills: false,
          syncClaudeAiPlugins: false,
        },
        agents: {},
        plugins: [],
        skills: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: input.maxTurns ?? DEFAULT_CLAUDE_MAX_TURNS,
        // API billing only: what the task may still spend (AGT-07). A
        // subscription's cost is nominal and is not capped here.
        ...(input.budgetUsd !== undefined && input.budgetUsd > 0
          ? { maxBudgetUsd: input.budgetUsd }
          : {}),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hook) => {
                  if (hook.hook_event_name !== 'PreToolUse') return {}
                  const reason = restriction(
                    hook.tool_name,
                    record(hook.tool_input),
                  )
                  if (reason) {
                    emit({ type: 'permission_denied', reason })
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: reason,
                      },
                    }
                  }
                  return {}
                },
              ],
            },
          ],
        },
        canUseTool: async (name, args, context) => {
          const reason = restriction(name, args)
          if (reason) return deny(reason)
          if (name === 'AskUserQuestion') {
            const questions = Array.isArray(args.questions)
              ? args.questions.map(record)
              : []
            if (
              !questions.length ||
              questions.length > 10 ||
              questions.some((q) => typeof q.question !== 'string')
            )
              return deny('QUESTION_INVALID: unsupported question payload')
            const requestId = 'dqi-' + randomUUID()
            return new Promise<PermissionResult>((resolve) => {
              const rows = questions.map((q, i) => ({
                question: q.question as string,
                id: 'q-' + i,
              }))
              const finish = (result: PermissionResult) => {
                context.signal.removeEventListener('abort', abort)
                resolve(result)
              }
              const abort = () => {
                pending.delete(requestId)
                finish({
                  behavior: 'deny',
                  message: 'Question cancelled',
                  interrupt: true,
                })
              }
              pending.set(requestId, {
                resolve: finish,
                raw: args,
                questions: rows,
              })
              context.signal.addEventListener('abort', abort, { once: true })
              if (context.signal.aborted) {
                abort()
                return
              }
              emit({
                type: 'question',
                requestId,
                questions: questions.map((q, i) => ({
                  id: 'q-' + i,
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
            })
          }
          if (context.blockedPath && input.policy.mode !== 'danger-full-access')
            return deny(
              'PERMISSION_DENIED: executor requested an additional directory',
            )
          return { behavior: 'allow', updatedInput: args }
        },
        spawnClaudeCodeProcess: (spawn) => {
          // SDK defaults may include ambient credentials. Only the host's resolved environment crosses this seam.
          handle = this.processes.spawn({
            executable: spawn.command,
            args: spawn.args,
            cwd: input.cwd,
            env: {
              ...input.environment,
              CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
              CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
              // The CLI's Bash, hooks and MCP children do not inherit its
              // credentials (AGT-02); it also pins the permission mode to
              // `default`, which is the mode requested above.
              CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
              // Never updates itself (VER-03): versions change only through
              // 设置 › 子智能体, where 退回 can undo one.
              DISABLE_AUTOUPDATER: '1',
            },
            signal: input.signal,
            policy: input.policy,
            secretValues: input.secretValues,
            onSpawn: input.onProcessStarted,
            onExit: input.onProcessExit,
          })
          return handle.spawnedProcess
        },
      }
      const start =
        this.options.startup ??
        ((options) => sdkStartup({ options, initializeTimeoutMs: 30_000 }))
      warm = await start(options)
      if (!handle)
        throw new DelegationError(
          'EXECUTOR_START_FAILED',
          'SDK bypassed managed process spawn',
        )
      await handle.started
      query = warm.query(prompts)
      const init = await query.initializationResult()
      if (init.hooks_applied === false)
        throw new DelegationError(
          'EXECUTOR_INCOMPATIBLE',
          'Claude did not apply required tool hooks',
        )
      // Before any prompt: builtins a newer claude brought are turned off
      // in this process; anything else it loaded refuses the run (VER-02).
      const preflight = await preflightClaudePlugins(
        query,
        this.ledger,
        input.executableVersion,
        this.options.preflightTimeoutMs,
      )
      let pluginNotice =
        preflight.status === 'adapted'
          ? {
              plugins: preflight.disabled,
              claudeVersion: input.executableVersion ?? 'unknown',
            }
          : undefined
      const seenTools = new Set<string>()
      const nativeCalls = new Map<string, { name: string; url?: string }>()
      let sawText = false
      void (async () => {
        try {
          for await (const message of query!) {
            const raw = record(message)
            if (raw.type === 'system' && raw.subtype === 'init') {
              if (raw.session_id !== providerSessionId)
                throw new DelegationError(
                  'PROVIDER_SESSION_CHANGED',
                  'Claude resumed a different session',
                )
              // Capability handshake (AGT-01): the installed claude must
              // report a supported version and honour the requested mode.
              const incompatible = claudeInitIssue(raw, {
                requireVersion: true,
              })
              if (incompatible)
                throw new DelegationError('EXECUTOR_INCOMPATIBLE', incompatible)
              if (
                Array.isArray(raw.tools) &&
                raw.tools.some(
                  (t) => typeof t === 'string' && forbidden.includes(t),
                )
              )
                throw new DelegationError(
                  'EXECUTOR_INCOMPATIBLE',
                  'Claude advertised disabled tools: ' +
                    JSON.stringify(
                      raw.tools.filter(
                        (t) => typeof t === 'string' && forbidden.includes(t),
                      ),
                    ),
                )
              // The last check (VER-02): the preflight turned the builtins
              // off, so what is still here is refused.
              const extensions = initExtensions(raw)
              if (extensions)
                throw new DelegationError(
                  'EXECUTOR_INCOMPATIBLE',
                  extensions,
                  extensions,
                )
              initialized = true
              if (active) acknowledge({ providerTurnId: active.messageId })
            }
            for (let event of normalizeClaudeMessage(
              message,
              !sawText,
              nativeCalls,
            )) {
              if (event.type === 'runtime_metadata') {
                let provider = 'anthropic'
                try {
                  if (input.environment.ANTHROPIC_BASE_URL)
                    provider = new URL(input.environment.ANTHROPIC_BASE_URL)
                      .hostname
                } catch {
                  provider = 'custom-provider'
                }
                event = { ...event, provider }
                if (pluginNotice && event.source === 'initialization') {
                  event = { ...event, builtinPluginsDisabled: pluginNotice }
                  pluginNotice = undefined
                }
              }
              if (event.type === 'text_delta') sawText = true
              if (event.type === 'tool_started') {
                if (seenTools.has(event.id)) continue
                seenTools.add(event.id)
              }
              if (event.type === 'usage' && input.resumeSessionId) {
                if (
                  input.usageBaseline?.estimatedUsd !== undefined &&
                  event.estimatedUsd !== undefined
                )
                  event = {
                    ...event,
                    estimatedUsd: Math.max(
                      0,
                      event.estimatedUsd - input.usageBaseline.estimatedUsd,
                    ),
                  }
                else {
                  const { estimatedUsd: _cost, ...rest } = event
                  event = rest
                }
              }
              if (event.type === 'turn_finished') {
                if (
                  active?.outputSchema &&
                  event.status === 'completed' &&
                  jsonSchema.validateJsonSchemaValue(
                    active.outputSchema,
                    event.structured,
                  ).length
                )
                  event = {
                    type: 'turn_finished',
                    status: 'failed',
                    error: 'STRUCTURED_OUTPUT_INVALID',
                  }
                if (interrupted && event.status === 'failed')
                  event = { ...event, status: 'interrupted' }
                if (active) acknowledge({ providerTurnId: active.messageId })
              }
              emit(event)
            }
          }
          if (!closed)
            throw new DelegationError(
              'CONNECTION_LOST',
              'Claude stream ended without managed close',
            )
        } catch (error) {
          if (closed) return
          const code =
            error instanceof DelegationError ? error.code : 'CONNECTION_LOST'
          const message =
            error instanceof DelegationError
              ? redactExecutorText(error.message, input.secretValues ?? [])
              : 'Claude protocol stream failed'
          const reason =
            error instanceof DelegationError && error.reason
              ? redactExecutorText(error.reason, input.secretValues ?? [])
              : undefined
          startFailure = new DelegationError(code, message, reason)
          rejectSubmit(startFailure)
          emit({
            type: 'transport_error',
            code,
            message,
            ...(reason ? { reason } : {}),
          })
          events.end()
        }
      })()
    } catch (error) {
      const receipt = await close()
      if (handle && !receipt.quiescent)
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'Claude startup process termination is unproven',
        )
      // Emperor refused what this claude loaded (VER-02): its own reason.
      if (error instanceof DelegationError && error.reason)
        throw new DelegationError(
          error.code,
          redactExecutorText(error.reason, input.secretValues ?? []),
          redactExecutorText(error.reason, input.secretValues ?? []),
        )
      throw new DelegationError(
        error instanceof DelegationError ? error.code : 'EXECUTOR_START_FAILED',
        redactExecutorText(
          handle?.diagnostics() || 'Claude SDK startup failed',
          input.secretValues ?? [],
        ).slice(0, 4096),
      )
    }
    const session: ExecutorSession = {
      providerSessionId,
      events,
      submit: async (turn) => {
        if (closed || startFailure)
          throw (
            startFailure ??
            new DelegationError('EXECUTOR_CLOSED', 'Claude process closed')
          )
        if (active)
          throw new DelegationError(
            'ACTIVE_RUN',
            'one turn per managed Claude process',
          )
        active = turn
        emit({ type: 'turn_started', turnId: turn.messageId })
        const accepted = new Promise<{ providerTurnId: string }>(
          (resolve, reject) => {
            acknowledge = resolve
            rejectSubmit = reject
          },
        )
        prompts.push({
          type: 'user',
          message: { role: 'user', content: turn.text },
          parent_tool_use_id: null,
          session_id: providerSessionId,
          uuid: randomUUID(),
        })
        if (initialized) acknowledge({ providerTurnId: turn.messageId })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            accepted,
            new Promise<never>((_r, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new DelegationError(
                      'ACCEPTANCE_TIMEOUT',
                      'Claude did not acknowledge input within 30 seconds',
                    ),
                  ),
                30000,
              )
              timer.unref()
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
      steer: async () => {
        throw new DelegationError(
          'UNSUPPORTED_OPTION',
          'Claude steer is not supported; use queued followup',
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
          request.resolve({
            behavior: 'deny',
            message: answer.reason,
            interrupt: true,
          })
          return
        }
        const answers: Record<string, string> = {}
        for (const question of request.questions) {
          const value = answer.answers[question.id]
          if (
            typeof value !== 'string' ||
            !value.trim() ||
            Buffer.byteLength(value) > 4096
          )
            throw new DelegationError(
              'INVALID_ANSWER',
              'each question needs a bounded text answer',
            )
          answers[question.question] = value
        }
        pending.delete(answer.requestId)
        request.resolve({
          behavior: 'allow',
          updatedInput: { ...request.raw, answers },
        })
      },
      interrupt: async () => {
        interrupted = true
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            query!.interrupt(),
            new Promise<never>((_r, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new DelegationError(
                      'INTERRUPT_TIMEOUT',
                      'Claude interrupt timed out',
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
    return session
  }
}
