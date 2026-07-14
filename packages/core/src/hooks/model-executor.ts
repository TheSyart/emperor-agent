import { createHash } from 'node:crypto'
import type { TokenTrackerLike } from '../agent/runner'
import { ModelConfigurationError } from '../errors'
import type { ModelRole, ModelRoute } from '../model/router'
import {
  type LLMResponse,
  type OpenAiMessage,
  type ToolCallRequest,
  toOpenAiToolCall,
} from '../providers/base'
import { GlobTool, GrepTool } from '../tools/search'
import { ReadFileTool } from '../tools/filesystem'
import {
  Tool,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../tools/base'
import { ToolRegistry } from '../tools/registry'
import type { ToolParamsSchema } from '../tools/schema'
import type {
  HookExecutorContext,
  HookExecutorOutcome,
  HookExecutorResultV2,
  HookHandlerExecutor,
} from './executor'
import {
  HOOK_EVENT_SPECS,
  type HookAgentHandlerV2,
  type HookEventName,
  type HookPromptHandlerV2,
} from './models'
import { parseHookOutput } from './schema'

export type HookModelUseCase = 'hook_prompt' | 'hook_agent'

export interface HookModelRequest {
  useCase: HookModelUseCase
  modelRole: ModelRole
  systemPrompt: string
  messages: OpenAiMessage[]
  tools: ToolDefinition[] | null
  signal: AbortSignal
}

export interface HookModelResponse {
  content: string | null
  toolCalls: ToolCallRequest[]
  usage: Record<string, number>
}

export interface HookModelGateway {
  call(request: HookModelRequest): Promise<HookModelResponse>
}

export interface HookModelRouter {
  routeForRole(
    useCase: HookModelUseCase,
    role: ModelRole,
    task?: string | null,
  ): ModelRoute
}

export class RoutedHookModelGateway implements HookModelGateway {
  constructor(
    private readonly router: HookModelRouter,
    private readonly tokenTracker: Pick<
      TokenTrackerLike,
      'record'
    > | null = null,
  ) {}

  async call(request: HookModelRequest): Promise<HookModelResponse> {
    const route = this.router.routeForRole(
      request.useCase,
      request.modelRole,
      request.messages
        .map((message) => String(message.content ?? ''))
        .join('\n'),
    )
    const messages: OpenAiMessage[] = [
      { role: 'system', content: request.systemPrompt },
      ...request.messages,
    ]
    const snapshot = route.snapshot
    if (request.tools?.length && snapshot.profile?.toolCall === false) {
      throw new ModelConfigurationError(
        '当前激活模型不支持工具调用，无法执行 Agent Hook。',
      )
    }
    const response: LLMResponse = await snapshot.provider.chat({
      messages,
      tools:
        (snapshot.profile?.toolCall ?? true)
          ? (request.tools as unknown as Array<Record<string, unknown>> | null)
          : null,
      model: snapshot.model,
      maxTokens: snapshot.generation.maxTokens,
      temperature: snapshot.generation.temperature,
      reasoningEffort: snapshot.generation.reasoningEffort,
      signal: request.signal,
    })
    this.tokenTracker?.record(snapshot.model, response.usage, {
      provider: snapshot.providerName,
      usageType: request.useCase,
      modelEntryId: snapshot.modelEntryId,
      routeReason: snapshot.routeReason,
      routeEstimatedTokens: route.estimatedTokens,
    })
    return {
      content: response.content,
      toolCalls: response.toolCalls,
      usage: response.usage,
    }
  }
}

export class PromptHookExecutor implements HookHandlerExecutor<HookPromptHandlerV2> {
  readonly type = 'prompt' as const

  constructor(private readonly gateway: HookModelGateway) {}

  async execute(
    handler: HookPromptHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    const started = Date.now()
    const preflight = modelPreflight('prompt', input, context, started)
    if (preflight) return preflight
    const scope = new ModelExecutionScope(
      context.signal ?? null,
      Math.min(handler.timeoutMs, context.policy.prompt.maxTimeoutMs),
    )
    try {
      const response = await scope.run(() =>
        this.gateway.call({
          useCase: 'hook_prompt',
          modelRole: handler.modelRole,
          systemPrompt: promptSystemPrompt(handler.prompt),
          messages: [
            {
              role: 'user',
              content: boundedHookInput(input, context.policy.maxContextBytes),
            },
          ],
          tools: null,
          signal: scope.signal,
        }),
      )
      const parsed = parseModelEnvelope(context.eventName, response.content)
      if (!parsed.output) return modelResult('failed', parsed.reason, started)
      return modelResult('completed', parsed.reason, started, parsed.output)
    } catch (error) {
      return modelScopeFailure(scope, error, started)
    } finally {
      scope.dispose()
    }
  }
}

export class AgentHookExecutor implements HookHandlerExecutor<HookAgentHandlerV2> {
  readonly type = 'agent' as const

  constructor(private readonly gateway: HookModelGateway) {}

  async execute(
    handler: HookAgentHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    const started = Date.now()
    const preflight = modelPreflight('agent', input, context, started)
    if (preflight) return preflight
    const scope = new ModelExecutionScope(
      context.signal ?? null,
      Math.min(handler.timeoutMs, context.policy.agent.maxTimeoutMs),
    )
    const submit = new SubmitHookResultTool(context.eventName)
    const registry = hookAgentRegistry(context.cwd, submit)
    const tools = registry.getDefinitions()
    const messages: OpenAiMessage[] = [
      {
        role: 'user',
        content: boundedHookInput(input, context.policy.maxContextBytes),
      },
    ]
    const maxTurns = Math.min(handler.maxTurns, context.policy.agent.maxTurns)
    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const response = await scope.run(() =>
          this.gateway.call({
            useCase: 'hook_agent',
            modelRole: handler.modelRole,
            systemPrompt: agentSystemPrompt(handler.prompt),
            messages,
            tools,
            signal: scope.signal,
          }),
        )
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: response.toolCalls.map((call) => toOpenAiToolCall(call)),
        })
        if (!response.toolCalls.length) {
          messages.push({
            role: 'user',
            content:
              'Submit the result with submit_hook_result. Plain text is not accepted.',
          })
          continue
        }
        for (const call of response.toolCalls) {
          if (!registry.has(call.name))
            return modelResult(
              'failed',
              `Hook agent attempted forbidden tool: ${call.name}`,
              started,
            )
          const toolResult = await registry.executeResult(
            call.name,
            call.arguments,
            {
              root: context.cwd,
              workspaceRoot: context.cwd,
              parentCallId: call.id,
              signal: scope.signal,
              executionEnvironment: context.executionEnvironment ?? null,
            },
          )
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: toolResult.modelContent,
          })
          if (submit.output)
            return modelResult(
              'completed',
              submit.reason,
              started,
              submit.output,
            )
        }
      }
      return modelResult(
        'failed',
        `Hook agent did not submit a structured result within ${maxTurns} max turns`,
        started,
      )
    } catch (error) {
      return modelScopeFailure(scope, error, started)
    } finally {
      scope.dispose()
    }
  }
}

export class SubmitHookResultTool extends Tool {
  readonly name = 'submit_hook_result'
  readonly description =
    'Submit the final structured hook decision. This ends the hook agent run.'
  readonly parameters: ToolParamsSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether the hook check passed' },
      reason: { type: 'string', description: 'Concise reason' },
      output: {
        type: 'object',
        description: 'Event-specific hook output',
        properties: {},
      },
    },
    required: ['ok'],
  }
  override readOnly = true
  output: Record<string, unknown> | null = null
  reason = ''

  constructor(private readonly eventName: HookEventName) {
    super()
  }

  execute(
    args: Record<string, unknown>,
    _context?: ToolExecutionContext,
  ): string {
    if (this.output) return '[ERR] hook result already submitted'
    const parsed = parseModelEnvelopeValue(this.eventName, args)
    if (!parsed.output) return `[ERR] ${parsed.reason}`
    this.output = parsed.output
    this.reason = parsed.reason
    return 'hook result submitted'
  }
}

function hookAgentRegistry(
  cwd: string,
  submit: SubmitHookResultTool,
): ToolRegistry {
  const registry = new ToolRegistry(cwd)
  registry.register(new ReadFileTool(cwd))
  registry.register(new GlobTool(cwd))
  registry.register(new GrepTool(cwd))
  registry.register(submit)
  return registry
}

function modelPreflight(
  type: 'prompt' | 'agent',
  input: Record<string, unknown>,
  context: HookExecutorContext,
  started: number,
): HookExecutorResultV2 | null {
  if (context.signal?.aborted)
    return modelResult(
      'cancelled',
      'Hook execution cancelled before start',
      started,
    )
  if (Number(input.hook_depth ?? 0) > 0)
    return modelResult(
      'failed',
      'Recursive hook model execution is denied by hook depth policy',
      started,
    )
  if (
    !(
      HOOK_EVENT_SPECS[context.eventName].allowedHandlers as readonly string[]
    ).includes(type)
  ) {
    return modelResult(
      'failed',
      `${type} hooks are not allowed for ${context.eventName}`,
      started,
    )
  }
  return null
}

function promptSystemPrompt(instruction: string): string {
  return [
    'You are evaluating an Emperor Agent hook event.',
    'Do not call tools. Return one JSON object and no markdown.',
    'The object must be {"ok":boolean,"reason"?:string,"output"?:object}.',
    'When ok is false, the event is explicitly denied. When ok is true, output must match the event protocol.',
    `Hook instruction: ${instruction}`,
  ].join('\n')
}

function agentSystemPrompt(instruction: string): string {
  return [
    'You are an isolated Emperor Agent hook evaluator.',
    'You may only inspect the workspace with read_file, glob, and grep.',
    'You cannot write, run commands, access MCP, dispatch agents, use Team, Ask, or Plan.',
    'You must finish by calling submit_hook_result. Plain text is never a final result.',
    `Hook instruction: ${instruction}`,
  ].join('\n')
}

function parseModelEnvelope(
  eventName: HookEventName,
  content: string | null,
): { output: Record<string, unknown> | null; reason: string } {
  if (!content?.trim())
    return { output: null, reason: 'Hook model returned an empty result' }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    return {
      output: null,
      reason: `Invalid hook model JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return parseModelEnvelopeValue(eventName, value)
}

function parseModelEnvelopeValue(
  eventName: HookEventName,
  value: unknown,
): { output: Record<string, unknown> | null; reason: string } {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return {
      output: null,
      reason: 'Hook model result must contain a boolean ok field',
    }
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !['ok', 'reason', 'output'].includes(key))) {
    return {
      output: null,
      reason: 'Hook model result contains unsupported fields',
    }
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return { output: null, reason: 'Hook model result reason must be a string' }
  }
  if (value.output !== undefined && !isRecord(value.output)) {
    return {
      output: null,
      reason: 'Hook model result output must be an object',
    }
  }
  const reason =
    typeof value.reason === 'string'
      ? value.reason
      : value.ok
        ? 'ok'
        : 'Hook model denied the event'
  const candidate = value.ok
    ? (value.output ?? {})
    : { decision: 'deny', reason }
  const parsed = parseHookOutput(eventName, candidate)
  if (!parsed.output) {
    return {
      output: null,
      reason:
        parsed.diagnostics.map((item) => item.message).join('; ') ||
        'Invalid event hook output',
    }
  }
  return { output: parsed.output, reason }
}

function boundedHookInput(
  input: Record<string, unknown>,
  maxBytes: number,
): string {
  const redacted = redactHookValue(input, 0)
  const serialized = JSON.stringify(redacted)
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized
  const hash = createHash('sha256').update(serialized).digest('hex')
  const summary = JSON.stringify({
    hook_event_name: shortString(input.hook_event_name),
    session_id: shortString(input.session_id),
    cwd: shortString(input.cwd),
    truncated: true,
    input_hash: hash,
  })
  if (Buffer.byteLength(summary) <= maxBytes) return summary
  const minimal = JSON.stringify({ truncated: true, input_hash: hash })
  if (Buffer.byteLength(minimal) <= maxBytes) return minimal
  return maxBytes >= 1 ? '0' : ''
}

function redactHookValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '[TRUNCATED_DEPTH]'
  if (typeof value === 'string')
    return value.length > 2_000 ? `${value.slice(0, 2_000)}[TRUNCATED]` : value
  if (Array.isArray(value))
    return value.slice(0, 20).map((entry) => redactHookValue(entry, depth + 1))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/^(transcript_path|transcriptPath)$/i.test(key)) continue
    if (/(api[_-]?key|token|secret|password|authorization|cookie)/i.test(key)) {
      result[key] = '[REDACTED]'
      continue
    }
    result[key] = redactHookValue(entry, depth + 1)
  }
  return result
}

function shortString(value: unknown): string {
  return String(value ?? '').slice(0, 120)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class ModelExecutionScope {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parent: AbortSignal | null
  private timedOut = false
  private cancelled = false

  constructor(parent: AbortSignal | null, timeoutMs: number) {
    this.parent = parent
    this.timer = setTimeout(
      () => {
        this.timedOut = true
        this.controller.abort(
          new Error(`Hook model timed out after ${timeoutMs}ms`),
        )
      },
      Math.max(1, timeoutMs),
    )
    if (parent?.aborted) this.cancelFromParent()
    else
      parent?.addEventListener('abort', this.cancelFromParent, { once: true })
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.signal.reason
    const aborted = new Promise<never>((_resolve, reject) => {
      this.signal.addEventListener('abort', () => reject(this.signal.reason), {
        once: true,
      })
    })
    return await Promise.race([operation(), aborted])
  }

  outcome(): 'timeout' | 'cancelled' | null {
    if (this.timedOut) return 'timeout'
    if (this.cancelled) return 'cancelled'
    return null
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.cancelFromParent)
  }

  private readonly cancelFromParent = (): void => {
    this.cancelled = true
    this.controller.abort(
      this.parent?.reason ?? new Error('Hook model execution cancelled'),
    )
  }
}

function modelScopeFailure(
  scope: ModelExecutionScope,
  error: unknown,
  started: number,
): HookExecutorResultV2 {
  const outcome = scope.outcome()
  if (outcome === 'timeout')
    return modelResult('timeout', 'Hook model execution timed out', started)
  if (outcome === 'cancelled')
    return modelResult('cancelled', 'Hook model execution cancelled', started)
  return modelResult(
    'failed',
    error instanceof Error ? error.message : String(error),
    started,
  )
}

function modelResult(
  outcome: HookExecutorOutcome,
  reason: string,
  started: number,
  output: Record<string, unknown> | null = null,
): HookExecutorResultV2 {
  return {
    outcome,
    output,
    reason,
    durationMs: Date.now() - started,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}
