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
  DelegationError,
  type ExecutorAdapter,
  type ExecutorOpenInput,
  type ExecutorSession,
  type ExecutorEventPayload,
  type ExecutorTurnInput,
  type NormalizedExecutorEvent,
} from '../types'
import {
  ManagedAgentProcess,
  readJsonLines,
  type ManagedProcessHandle,
} from '../process'
import { redactExecutorText } from '../redaction'
import { jsonSchema } from '../../tools/json-schema'
import { AsyncQueue } from './async-queue'
import { CLAUDE_HOST_TOOLS, publicReferences } from '../facts'
import { claudeInitIssue } from '../compatibility'
import {
  bundledClaudeExecutable,
  claudeExecutableSource,
  executorExecutable,
} from '../executable'
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
    else
      events.push({
        type: 'turn_finished',
        status: 'failed',
        error: Array.isArray(m.errors)
          ? m.errors
              .filter((x) => typeof x === 'string')
              .join('; ')
              .slice(0, 4096)
          : 'Claude execution failed',
      })
  }
  return events
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
  constructor(
    private readonly options: {
      processes?: ManagedAgentProcess
      startup?: (
        options: Options,
      ) => Promise<Pick<WarmQuery, 'query' | 'close'>>
      /** Test hook: where the SDK-bundled claude lives. */
      bundledClaude?: () => string | undefined
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
        'history inspection needs an existing Claude session',
      )
    // SDK session-reading helpers use process env for their config directory.
    // A separate Node process keeps per-conversation state out of the host env.
    const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk')
    const source = `const {getSessionMessages}=await import(process.argv[1]);const sessionId=process.argv[2];const rows=await getSessionMessages(sessionId,{dir:process.argv[3]});const turns=rows.slice(-20).map(row=>({id:row.uuid,status:row.type,text:Array.isArray(row.message?.content)?row.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\\n'):typeof row.message?.content==='string'?row.message.content:''})).map(row=>({...row,text:row.text.slice(-8192)}));console.log(JSON.stringify({sessionId,nativeStatus:'unknown',turns}));`
    const h = await this.processes.open({
      executable: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        source,
        sdk,
        input.resumeSessionId,
        input.cwd,
      ],
      cwd: input.cwd,
      env: { ...input.environment, ELECTRON_RUN_AS_NODE: '1' },
      policy: input.policy,
      signal: input.signal,
      secretValues: input.secretValues,
      onSpawn: input.onProcessStarted,
      onExit: input.onProcessExit,
    })
    let value: import('../types').NativeSessionInspection | undefined
    try {
      for await (const row of readJsonLines(h.stdout)) {
        if (
          value ||
          row.sessionId !== input.resumeSessionId ||
          !Array.isArray(row.turns)
        )
          throw new DelegationError(
            'PROTOCOL_INVALID',
            'unexpected SDK history response',
          )
        value = row as unknown as import('../types').NativeSessionInspection
      }
      const receipt = await h.closed
      if (receipt.exitCode !== 0 || !receipt.quiescent || !value)
        throw new DelegationError(
          'HISTORY_UNAVAILABLE',
          'SDK history inspection failed',
        )
      return value
    } finally {
      await h.terminate()
    }
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
    // The SDK-bundled binary unless the user chose the installed claude.
    const executable = executorExecutable(
      input.profile,
      this.options.bundledClaude ?? bundledClaudeExecutable,
    )
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
          ].join('\n\n'),
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
          enabledPlugins: {
            'agents-md@builtin': false,
            'telemetry@builtin': false,
          },
          syncClaudeAiSkills: false,
          syncClaudeAiPlugins: false,
        },
        agents: {},
        plugins: [],
        skills: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 64,
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
              // Capability handshake (AGT-01): an installed claude must
              // report a supported version and honour the requested mode.
              const incompatible = claudeInitIssue(raw, {
                requireVersion:
                  claudeExecutableSource(input.profile) === 'system',
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
              if (
                (Array.isArray(raw.plugins) && raw.plugins.length) ||
                (Array.isArray(raw.mcp_servers) && raw.mcp_servers.length)
              )
                throw new DelegationError(
                  'EXECUTOR_INCOMPATIBLE',
                  'Claude loaded unapproved plugins or MCP servers: ' +
                    JSON.stringify({
                      plugins: raw.plugins,
                      mcp_servers: raw.mcp_servers,
                    }),
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
          startFailure = new DelegationError(code, message)
          rejectSubmit(startFailure)
          emit({
            type: 'transport_error',
            code,
            message,
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
