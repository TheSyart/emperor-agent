import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentRequestContext,
  type JsonRpcId,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import { AcpEventProjector } from './projector'

type Row = Record<string, unknown>

const MAX_PROMPTS_PER_CONNECTION = 64
const MAX_TERMINAL_REQUESTS = 1_024
const MAX_PROMPT_BYTES = 1024 * 1024

export interface EmperorAcpSession {
  id: string
  mode: string
  project_path: string | null
  archived_at?: string | null
}

export interface EmperorAcpSubmitInput {
  content: string
  sessionId: string
  turnId?: string
  clientMessageId?: string
  source: string
  signal: AbortSignal
  emit?: (event: Row) => void | Promise<void>
}

export interface EmperorAcpCore {
  readonly root: string
  readonly sessions: {
    list(opts?: { includeArchived?: boolean }): EmperorAcpSession[]
    create(opts: {
      title?: string
      mode?: string
      project_path?: string | null
    }): EmperorAcpSession
  }
  readonly runtime: {
    replay(opts: {
      sessionId: string
      afterSeq: number
      limit: number
      includeArchive: boolean
      compact: boolean
      format: 'projection'
    }): {
      events: Row[]
      latestSeq: number
    }
  }
  readonly chat: {
    submit(input: EmperorAcpSubmitInput): Promise<{
      turnId: string
      content: string
      activeSessionId: string | null
    }>
  }
}

export interface EmperorAcpAdapterOptions {
  version?: string
  maxPrompts?: number
  maxTerminalRequests?: number
}

interface ActivePrompt {
  readonly requestKey: string
  readonly sessionId: string
  readonly turnId: string
  readonly controller: AbortController
  readonly projector: AcpEventProjector
  phase: 'running' | 'completed' | 'cancelled' | 'failed'
}

export class EmperorAcpAdapter {
  readonly agentApp: AgentApp
  private readonly core: EmperorAcpCore
  private readonly maxPrompts: number
  private readonly ledger: RequestLedger
  private readonly activePrompts = new Map<string, ActivePrompt>()
  private readonly running = new Set<Promise<unknown>>()
  private initialized = false

  constructor(core: EmperorAcpCore, opts: EmperorAcpAdapterOptions = {}) {
    this.core = core
    this.maxPrompts = positiveInteger(
      opts.maxPrompts ?? MAX_PROMPTS_PER_CONNECTION,
      'maxPrompts',
    )
    this.ledger = new RequestLedger(
      opts.maxTerminalRequests ?? MAX_TERMINAL_REQUESTS,
    )
    const version = cleanText(opts.version) || '0.0.0'
    this.agentApp = agent({ name: 'emperor-agent' })
      .onConnect((connection) => {
        void connection.closed.then(() => this.abortAll('connection_closed'))
      })
      .onRequest(methods.agent.initialize, async (context) =>
        await this.ledger.run(
          'initialize',
          context.requestId,
          context.params,
          async () => {
            this.initialized = true
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: {
                  image: false,
                  audio: false,
                  embeddedContext: false,
                },
              },
              agentInfo: { name: 'emperor-agent', version },
              _meta: {
                emperor: {
                  transport: 'stdio',
                  runtime: 'core-api',
                  content: 'text-only',
                },
              },
            }
          },
        ),
      )
      .onRequest(methods.agent.session.new, async (context) =>
        await this.ledger.run(
          'session/new',
          context.requestId,
          context.params,
          async () => await this.newSession(context.params),
        ),
      )
      .onRequest(methods.agent.session.load, async (context) =>
        await this.ledger.run(
          'session/load',
          context.requestId,
          context.params,
          async () => await this.loadSession(context),
        ),
      )
      .onRequest(methods.agent.session.prompt, async (context) =>
        await this.ledger.run(
          'session/prompt',
          context.requestId,
          context.params,
          async () => await this.prompt(context),
        ),
      )
      .onNotification(methods.agent.session.cancel, ({ params }) => {
        this.activePrompts
          .get(params.sessionId)
          ?.controller.abort(abortError('session_cancelled'))
      })
  }

  async settle(): Promise<void> {
    while (this.running.size) {
      await Promise.allSettled([...this.running])
    }
  }

  abortAll(reason = 'adapter_closed'): void {
    for (const prompt of this.activePrompts.values()) {
      prompt.controller.abort(abortError(reason))
    }
  }

  private async newSession(
    params: NewSessionRequest,
  ): Promise<NewSessionResponse> {
    this.assertInitialized()
    assertNoClientAuthority(params)
    const cwd = canonicalDirectory(params.cwd)
    const created = this.core.sessions.create({
      title: 'ACP session',
      mode: 'build',
      project_path: cwd,
    })
    return {
      sessionId: created.id,
      _meta: { emperor: { mode: 'build', workspace: 'canonical-cwd' } },
    }
  }

  private async loadSession(
    context: AgentRequestContext<LoadSessionRequest>,
  ): Promise<LoadSessionResponse> {
    this.assertInitialized()
    assertNoClientAuthority(context.params)
    const session = this.requireSession(context.params.sessionId)
    const cwd = canonicalDirectory(context.params.cwd)
    if (session.mode !== 'build' || !session.project_path) {
      throw RequestError.invalidParams(
        { sessionId: session.id },
        'ACP can load only Build sessions with a persisted workspace',
      )
    }
    if (canonicalDirectory(session.project_path) !== cwd) {
      throw RequestError.invalidParams(
        { sessionId: session.id },
        'session cwd does not match the persisted workspace',
      )
    }
    const replay = this.core.runtime.replay({
      sessionId: session.id,
      afterSeq: 0,
      limit: 50_000,
      includeArchive: true,
      compact: false,
      format: 'projection',
    })
    const projectors = new Map<string, AcpEventProjector>()
    let replayedUpdates = 0
    for (const event of replay.events) {
      const turnId = cleanText(event.turn_id ?? event.turnId) || 'replay'
      let projector = projectors.get(turnId)
      if (!projector) {
        projector = new AcpEventProjector({
          sessionId: session.id,
          turnId,
          replay: true,
        })
        projectors.set(turnId, projector)
      }
      for (const notification of projector.project(event)) {
        await context.client.notify(
          methods.client.session.update,
          notification,
        )
        replayedUpdates += 1
      }
    }
    for (const projector of projectors.values()) projector.terminate()
    return {
      _meta: {
        emperor: { latestSeq: replay.latestSeq, replayedUpdates },
      },
    }
  }

  private async prompt(
    context: AgentRequestContext<PromptRequest>,
  ): Promise<PromptResponse> {
    this.assertInitialized()
    const session = this.requireSession(context.params.sessionId)
    const content = promptText(context.params.prompt)
    if (this.activePrompts.has(session.id)) {
      throw RequestError.invalidRequest(
        { sessionId: session.id },
        'session already has an active prompt',
      )
    }
    if (this.activePrompts.size >= this.maxPrompts) {
      throw RequestError.invalidRequest(
        { limit: this.maxPrompts },
        'ACP connection prompt capacity reached',
      )
    }
    const requestKey = jsonRpcIdKey(context.requestId)
    const turnId = `acp_${digest(`${requestKey}:${fingerprint(context.params)}`).slice(0, 20)}`
    const controller = new AbortController()
    const onRequestAbort = (): void => {
      controller.abort(context.signal.reason ?? abortError('request_cancelled'))
    }
    if (context.signal.aborted) onRequestAbort()
    else context.signal.addEventListener('abort', onRequestAbort, { once: true })
    const projector = new AcpEventProjector({
      sessionId: session.id,
      turnId,
    })
    const active: ActivePrompt = {
      requestKey,
      sessionId: session.id,
      turnId,
      controller,
      projector,
      phase: 'running',
    }
    this.activePrompts.set(session.id, active)
    const pause = { interaction: null as Row | null }
    try {
      const submitted = this.track(
        this.core.chat.submit({
          content,
          sessionId: session.id,
          turnId,
          clientMessageId: turnId,
          source: 'acp',
          signal: controller.signal,
          emit: async (event) => {
            if (active.phase !== 'running') return
            if (cleanText(event.event) === 'turn_paused') {
              pause.interaction = isRecord(event.interaction)
                ? event.interaction
                : {}
            }
            for (const notification of projector.project(event)) {
              await context.client.notify(
                methods.client.session.update,
                notification,
              )
            }
          },
        }),
      )
      const result = await submitted
      if (controller.signal.aborted) {
        active.phase = 'cancelled'
        return cancelledResponse(active)
      }
      if (pause.interaction) {
        active.phase = 'completed'
        return pausedResponse(active, pause.interaction)
      }
      active.phase = 'completed'
      return {
        stopReason: 'end_turn',
        _meta: {
          emperor: {
            requestId: requestKey,
            turnId: result.turnId || turnId,
          },
        },
      }
    } catch (error) {
      if (controller.signal.aborted) {
        active.phase = 'cancelled'
        return cancelledResponse(active)
      }
      if (pause.interaction || errorName(error) === 'TurnPaused') {
        active.phase = 'completed'
        return pausedResponse(active, pause.interaction)
      }
      active.phase = 'failed'
      throw error
    } finally {
      projector.terminate()
      context.signal.removeEventListener('abort', onRequestAbort)
      if (this.activePrompts.get(session.id) === active)
        this.activePrompts.delete(session.id)
    }
  }

  private requireSession(sessionId: string): EmperorAcpSession {
    const session = this.core.sessions
      .list({ includeArchived: true })
      .find((item) => item.id === sessionId)
    if (!session || session.archived_at) {
      throw RequestError.resourceNotFound(`session:${sessionId}`)
    }
    return session
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw RequestError.invalidRequest(undefined, 'initialize is required')
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.running.add(promise)
    void promise.then(
      () => this.running.delete(promise),
      () => this.running.delete(promise),
    )
    return promise
  }
}

interface LedgerEntry {
  readonly fingerprint: string
  readonly promise: Promise<unknown>
  terminal: boolean
}

class RequestLedger {
  private readonly maxTerminal: number
  private readonly entries = new Map<string, LedgerEntry>()

  constructor(maxTerminal: number) {
    this.maxTerminal = positiveInteger(maxTerminal, 'maxTerminalRequests')
  }

  run<T>(
    method: string,
    id: JsonRpcId,
    params: unknown,
    effect: () => Promise<T>,
  ): Promise<T> {
    const key = `${method}:${jsonRpcIdKey(id)}`
    const requestFingerprint = fingerprint(params)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw RequestError.invalidRequest(
          { method },
          'JSON-RPC request ID was reused with different parameters',
        )
      }
      return existing.promise as Promise<T>
    }
    const entry: LedgerEntry = {
      fingerprint: requestFingerprint,
      promise: Promise.resolve().then(effect),
      terminal: false,
    }
    this.entries.set(key, entry)
    void entry.promise.then(
      () => this.markTerminal(entry),
      () => this.markTerminal(entry),
    )
    return entry.promise as Promise<T>
  }

  private markTerminal(entry: LedgerEntry): void {
    entry.terminal = true
    let terminal = [...this.entries.values()].filter((item) => item.terminal)
      .length
    if (terminal <= this.maxTerminal) return
    for (const [key, candidate] of this.entries) {
      if (!candidate.terminal) continue
      this.entries.delete(key)
      terminal -= 1
      if (terminal <= this.maxTerminal) break
    }
  }
}

function cancelledResponse(active: ActivePrompt): PromptResponse {
  return {
    stopReason: 'cancelled',
    _meta: {
      emperor: {
        requestId: active.requestKey,
        turnId: active.turnId,
      },
    },
  }
}

function pausedResponse(
  active: ActivePrompt,
  interaction: Row | null,
): PromptResponse {
  return {
    stopReason: 'refusal',
    _meta: {
      emperor: {
        requestId: active.requestKey,
        turnId: active.turnId,
        interactionRequired: true,
        interactionId: cleanText(interaction?.id) || undefined,
      },
    },
  }
}

function assertNoClientAuthority(
  params: Pick<NewSessionRequest, 'additionalDirectories' | 'mcpServers'>,
): void {
  if (params.additionalDirectories?.length) {
    throw RequestError.invalidParams(
      { field: 'additionalDirectories' },
      'additionalDirectories are not supported',
    )
  }
  if (params.mcpServers.length) {
    throw RequestError.invalidParams(
      { field: 'mcpServers' },
      'client-supplied mcpServers are not supported',
    )
  }
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw RequestError.invalidParams({ field: 'cwd' }, 'cwd must be absolute')
  }
  try {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    throw RequestError.invalidParams(
      { field: 'cwd' },
      'cwd must be an existing directory',
    )
  }
}

function promptText(blocks: PromptRequest['prompt']): string {
  const values: string[] = []
  for (const block of blocks) {
    if (block.type !== 'text') {
      throw RequestError.invalidParams(
        { field: 'prompt' },
        'only text content is supported',
      )
    }
    values.push(block.text)
  }
  const output = values.join('\n')
  const bytes = Buffer.byteLength(output)
  if (!output.trim())
    throw RequestError.invalidParams({ field: 'prompt' }, 'prompt is empty')
  if (bytes > MAX_PROMPT_BYTES) {
    throw RequestError.invalidParams(
      { field: 'prompt', bytes, limit: MAX_PROMPT_BYTES },
      'prompt exceeds the text limit',
    )
  }
  return output
}

function fingerprint(value: unknown): string {
  return digest(stableJson(value))
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function jsonRpcIdKey(id: JsonRpcId): string {
  return JSON.stringify(id)
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function abortError(reason: string): DOMException {
  return new DOMException(reason, 'AbortError')
}

function errorName(error: unknown): string {
  return isRecord(error) && typeof error.name === 'string' ? error.name : ''
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
