export type SessionRuntimeCommandState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type SessionInterjectionState = 'queued' | 'interjected' | 'cancelled'

export interface SessionInterjection<TPayload = unknown> {
  id: string
  targetCommandId: string
  payload: TPayload
  state: SessionInterjectionState
  reason: string | null
}

export interface SessionInterjectionInput<TPayload = unknown> {
  id: string
  payload: TPayload
  onState?: (item: SessionInterjection<TPayload>) => void | Promise<void>
}

export interface SessionInterjectionResult<TPayload = unknown> {
  accepted: boolean
  targetCommandId: string | null
  item: SessionInterjection<TPayload> | null
  reason: string | null
}

export interface SessionRuntimeActorSnapshot {
  sessionId: string
  running: boolean
  queued: number
  closed: boolean
  commandReceipts: number
  pendingInterjections: number
  interjectionReceipts: number
  illegalTransitions: number
  lastUsed: number
}

export class SessionRuntimeCapacityError extends Error {
  readonly code = 'session_runtime_capacity'

  constructor(readonly maxActiveActors: number) {
    super(`session runtime capacity reached: ${maxActiveActors}`)
    this.name = 'SessionRuntimeCapacityError'
  }
}

export class SessionRuntimeCommandCancelledError extends Error {
  readonly code = 'session_runtime_command_cancelled'

  constructor(readonly commandId: string) {
    super(`session runtime command cancelled: ${commandId}`)
    this.name = 'SessionRuntimeCommandCancelledError'
  }
}

export class SessionRuntimeQueueCapacityError extends Error {
  readonly code = 'session_runtime_queue_capacity'

  constructor(
    readonly sessionId: string,
    readonly maxQueuedCommands: number,
  ) {
    super(
      `session runtime queue capacity reached for ${sessionId}: ${maxQueuedCommands}`,
    )
    this.name = 'SessionRuntimeQueueCapacityError'
  }
}

export class SessionRuntimeClosedError extends Error {
  readonly code = 'session_runtime_closed'

  constructor(readonly sessionId: string) {
    super(`session runtime is closed: ${sessionId}`)
    this.name = 'SessionRuntimeClosedError'
  }
}

interface CommandReceipt<TResult = unknown> {
  readonly commandId: string
  readonly controller: AbortController
  promise: Promise<TResult>
  state: SessionRuntimeCommandState
}

interface InterjectionReceipt<
  TPayload = unknown,
> extends SessionInterjection<TPayload> {
  onState?: (item: SessionInterjection<TPayload>) => void | Promise<void>
}

export class SessionRuntimeActor<TBindings> {
  readonly sessionId: string
  readonly bindings: TBindings
  private readonly commandReceiptLimit: number
  private readonly maxQueuedCommands: number
  private readonly receipts = new Map<string, CommandReceipt>()
  private readonly interjections = new Map<string, InterjectionReceipt>()
  private mailbox: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | null = null
  private closing = false
  private closed = false
  private illegalTransitions = 0
  private runningCommandId: string | null = null
  private _lastUsed: number

  constructor(opts: {
    sessionId: string
    bindings: TBindings
    commandReceiptLimit: number
    maxQueuedCommands: number
    lastUsed: number
  }) {
    this.sessionId = opts.sessionId
    this.bindings = opts.bindings
    this.commandReceiptLimit = Math.max(1, opts.commandReceiptLimit)
    this.maxQueuedCommands = Math.max(1, opts.maxQueuedCommands)
    this._lastUsed = opts.lastUsed
  }

  get lastUsed(): number {
    return this._lastUsed
  }

  get activeCommandId(): string | null {
    return this.runningCommandId
  }

  get idle(): boolean {
    return !this.closed && !this.hasNonTerminalCommands()
  }

  commandState(commandId: string): SessionRuntimeCommandState | null {
    return this.receipts.get(String(commandId))?.state ?? null
  }

  touch(value: number): void {
    this._lastUsed = Math.max(this._lastUsed, value)
  }

  run<TResult>(
    commandId: string,
    execute: (bindings: TBindings, signal: AbortSignal) => Promise<TResult>,
    opts: { signal?: AbortSignal | null; touchedAt?: number } = {},
  ): Promise<TResult> {
    const id = normalizedId(commandId, 'commandId')
    if (this.closing || this.closed)
      return Promise.reject(new SessionRuntimeClosedError(this.sessionId))
    const existing = this.receipts.get(id)
    if (existing) return existing.promise as Promise<TResult>
    const queued = [...this.receipts.values()].filter(
      (receipt) => receipt.state === 'queued',
    ).length
    if (queued >= this.maxQueuedCommands)
      throw new SessionRuntimeQueueCapacityError(
        this.sessionId,
        this.maxQueuedCommands,
      )
    if (opts.touchedAt !== undefined) this.touch(opts.touchedAt)

    const controller = new AbortController()
    const externalSignal = opts.signal ?? null
    const abortFromExternal = () => controller.abort(externalSignal?.reason)
    if (externalSignal?.aborted) abortFromExternal()
    else
      externalSignal?.addEventListener('abort', abortFromExternal, {
        once: true,
      })

    const receipt: CommandReceipt<TResult> = {
      commandId: id,
      controller,
      state: 'queued' as SessionRuntimeCommandState,
      promise: undefined as unknown as Promise<TResult>,
    }
    const promise = this.mailbox.then(async () => {
      if (controller.signal.aborted) {
        this.transition(receipt, 'cancelled')
        throw new SessionRuntimeCommandCancelledError(id)
      }
      this.transition(receipt, 'running')
      this.runningCommandId = id
      try {
        const result = await execute(this.bindings, controller.signal)
        if (controller.signal.aborted) {
          this.transition(receipt, 'cancelled')
          throw new SessionRuntimeCommandCancelledError(id)
        }
        this.transition(receipt, 'succeeded')
        return result
      } catch (error) {
        if (controller.signal.aborted) {
          if (receipt.state === 'running') this.transition(receipt, 'cancelled')
          if (error instanceof SessionRuntimeCommandCancelledError) throw error
          throw new SessionRuntimeCommandCancelledError(id)
        }
        this.transition(receipt, 'failed')
        throw error
      } finally {
        if (this.runningCommandId === id) this.runningCommandId = null
        externalSignal?.removeEventListener('abort', abortFromExternal)
      }
    }) as Promise<TResult>
    receipt.promise = promise
    this.receipts.set(id, receipt)
    this.mailbox = promise.then(
      () => undefined,
      () => undefined,
    )
    void promise.then(
      () => this.trimReceipts(),
      () => this.trimReceipts(),
    )
    return promise
  }

  cancel(commandId?: string | null): boolean {
    const selected = commandId
      ? [this.receipts.get(String(commandId))].filter(
          (receipt): receipt is CommandReceipt => Boolean(receipt),
        )
      : [...this.receipts.values()]
    let cancelled = false
    for (const receipt of selected) {
      if (isTerminal(receipt.state)) continue
      cancelled = true
      this.cancelInterjectionsForTarget(
        receipt.commandId,
        'target_command_cancelled',
      )
      receipt.controller.abort(
        new SessionRuntimeCommandCancelledError(receipt.commandId),
      )
    }
    return cancelled
  }

  cancelQueued(commandId: string): boolean {
    const receipt = this.receipts.get(normalizedId(commandId, 'commandId'))
    if (!receipt || receipt.state !== 'queued') return false
    receipt.controller.abort(
      new SessionRuntimeCommandCancelledError(receipt.commandId),
    )
    return true
  }

  cancelQueuedInterjection(
    interjectionId: string,
    reason = 'cancelled_by_user',
    opts: { notify?: boolean } = {},
  ): boolean {
    const receipt = this.interjections.get(
      normalizedId(interjectionId, 'interjection id'),
    )
    if (!receipt || receipt.state !== 'queued') return false
    receipt.state = 'cancelled'
    receipt.reason = reason
    if (opts.notify !== false) this.notifyInterjection(receipt)
    this.trimInterjections()
    return true
  }

  replaceQueuedWithInterjection<TPayload>(
    commandId: string,
    input: SessionInterjectionInput<TPayload>,
    opts: { commit?: (targetCommandId: string) => void } = {},
  ): SessionInterjectionResult<TPayload> {
    const receipt = this.receipts.get(normalizedId(commandId, 'commandId'))
    if (!receipt || receipt.state !== 'queued')
      return {
        accepted: false,
        targetCommandId: null,
        item: null,
        reason: 'prompt_not_queued',
      }
    if (!this.runningCommandId)
      return {
        accepted: false,
        targetCommandId: null,
        item: null,
        reason: 'no_running_command',
      }
    const result = this.interject(input, opts)
    if (!result.accepted) return result
    receipt.controller.abort(
      new SessionRuntimeCommandCancelledError(receipt.commandId),
    )
    return result
  }

  interject<TPayload>(
    input: SessionInterjectionInput<TPayload>,
    opts: { commit?: (targetCommandId: string) => void } = {},
  ): SessionInterjectionResult<TPayload> {
    const id = normalizedId(input.id, 'interjection id')
    const existing = this.interjections.get(id) as
      InterjectionReceipt<TPayload> | undefined
    if (existing)
      return {
        accepted: existing.state !== 'cancelled',
        targetCommandId: existing.targetCommandId,
        item: publicInterjection(existing),
        reason: existing.reason,
      }
    const targetCommandId = this.runningCommandId
    if (!targetCommandId)
      return {
        accepted: false,
        targetCommandId: null,
        item: null,
        reason: 'no_running_command',
      }
    opts.commit?.(targetCommandId)
    const receipt: InterjectionReceipt<TPayload> = {
      id,
      targetCommandId,
      payload: input.payload,
      state: 'queued',
      reason: null,
      ...(input.onState ? { onState: input.onState } : {}),
    }
    this.interjections.set(id, receipt as InterjectionReceipt)
    this.notifyInterjection(receipt)
    return {
      accepted: true,
      targetCommandId,
      item: publicInterjection(receipt),
      reason: null,
    }
  }

  consumeInterjections<TPayload>(
    commandId: string,
  ): Array<SessionInterjection<TPayload>> {
    const target = normalizedId(commandId, 'commandId')
    if (this.runningCommandId !== target) return []
    const out: Array<SessionInterjection<TPayload>> = []
    for (const receipt of this.interjections.values()) {
      if (receipt.targetCommandId !== target || receipt.state !== 'queued')
        continue
      receipt.state = 'interjected'
      receipt.reason = null
      this.notifyInterjection(receipt)
      out.push(publicInterjection(receipt as InterjectionReceipt<TPayload>))
    }
    this.trimInterjections()
    return out
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.cancel()
    this.closePromise = this.mailbox.then(() => {
      this.closed = true
    })
    return this.closePromise
  }

  snapshot(): SessionRuntimeActorSnapshot {
    const states = [...this.receipts.values()].map((receipt) => receipt.state)
    return {
      sessionId: this.sessionId,
      running: states.includes('running'),
      queued: states.filter((state) => state === 'queued').length,
      closed: this.closed,
      commandReceipts: this.receipts.size,
      pendingInterjections: [...this.interjections.values()].filter(
        (item) => item.state === 'queued',
      ).length,
      interjectionReceipts: this.interjections.size,
      illegalTransitions: this.illegalTransitions,
      lastUsed: this.lastUsed,
    }
  }

  private transition(
    receipt: CommandReceipt,
    next: SessionRuntimeCommandState,
  ): void {
    const allowed = ALLOWED_TRANSITIONS[receipt.state]
    if (!allowed.has(next)) {
      this.illegalTransitions += 1
      throw new Error(
        `illegal session runtime command transition: ${receipt.state} -> ${next}`,
      )
    }
    receipt.state = next
  }

  private hasNonTerminalCommands(): boolean {
    return [...this.receipts.values()].some(
      (receipt) => !isTerminal(receipt.state),
    )
  }

  private trimReceipts(): void {
    if (this.receipts.size <= this.commandReceiptLimit) return
    for (const [commandId, receipt] of this.receipts) {
      if (!isTerminal(receipt.state)) continue
      this.receipts.delete(commandId)
      if (this.receipts.size <= this.commandReceiptLimit) return
    }
  }

  private cancelInterjectionsForTarget(
    commandId: string,
    reason: string,
  ): void {
    for (const receipt of this.interjections.values()) {
      if (receipt.targetCommandId !== commandId || receipt.state !== 'queued')
        continue
      receipt.state = 'cancelled'
      receipt.reason = reason
      this.notifyInterjection(receipt)
    }
    this.trimInterjections()
  }

  private notifyInterjection<TPayload>(
    receipt: InterjectionReceipt<TPayload>,
  ): void {
    if (!receipt.onState) return
    void Promise.resolve(receipt.onState(publicInterjection(receipt))).catch(
      () => undefined,
    )
  }

  private trimInterjections(): void {
    if (this.interjections.size <= this.commandReceiptLimit) return
    for (const [id, receipt] of this.interjections) {
      if (receipt.state === 'queued') continue
      this.interjections.delete(id)
      if (this.interjections.size <= this.commandReceiptLimit) return
    }
  }
}

export class SessionRuntimeManager<TBindings> {
  readonly maxActiveActors: number
  private readonly commandReceiptLimit: number
  private readonly maxQueuedCommands: number
  private readonly createBindings: (sessionId: string) => TBindings
  private readonly actors = new Map<string, SessionRuntimeActor<TBindings>>()
  private logicalClock = 0

  constructor(opts: {
    maxActiveActors?: number
    commandReceiptLimit?: number
    maxQueuedCommands?: number
    createBindings: (sessionId: string) => TBindings
  }) {
    this.maxActiveActors = Math.max(1, opts.maxActiveActors ?? 2)
    this.commandReceiptLimit = Math.max(1, opts.commandReceiptLimit ?? 256)
    this.maxQueuedCommands = Math.max(1, opts.maxQueuedCommands ?? 64)
    this.createBindings = opts.createBindings
  }

  actor(sessionId: string): SessionRuntimeActor<TBindings> {
    const id = normalizedId(sessionId, 'sessionId')
    const existing = this.actors.get(id)
    if (existing) {
      existing.touch(this.nextClock())
      return existing
    }
    const evictionCandidate = this.idleEvictionCandidate()
    if (this.actors.size >= this.maxActiveActors && !evictionCandidate)
      throw new SessionRuntimeCapacityError(this.maxActiveActors)
    const bindings = this.createBindings(id)
    if (evictionCandidate) {
      this.actors.delete(evictionCandidate.sessionId)
      void evictionCandidate.close()
    }
    const actor = new SessionRuntimeActor({
      sessionId: id,
      bindings,
      commandReceiptLimit: this.commandReceiptLimit,
      maxQueuedCommands: this.maxQueuedCommands,
      lastUsed: this.nextClock(),
    })
    this.actors.set(id, actor)
    return actor
  }

  run<TResult>(
    sessionId: string,
    commandId: string,
    execute: (bindings: TBindings, signal: AbortSignal) => Promise<TResult>,
    opts: { signal?: AbortSignal | null } = {},
  ): Promise<TResult> {
    const actor = this.actor(sessionId)
    return actor.run(commandId, execute, {
      signal: opts.signal,
      touchedAt: this.nextClock(),
    })
  }

  cancel(sessionId: string, commandId?: string | null): boolean {
    return this.actors.get(String(sessionId))?.cancel(commandId) ?? false
  }

  interject<TPayload>(
    sessionId: string,
    input: SessionInterjectionInput<TPayload>,
  ): SessionInterjectionResult<TPayload> {
    const actor = this.actors.get(String(sessionId))
    if (!actor)
      return {
        accepted: false,
        targetCommandId: null,
        item: null,
        reason: 'session_runtime_not_open',
      }
    return actor.interject(input)
  }

  consumeInterjections<TPayload>(
    sessionId: string,
    commandId: string,
  ): Array<SessionInterjection<TPayload>> {
    return (
      this.actors
        .get(String(sessionId))
        ?.consumeInterjections<TPayload>(commandId) ?? []
    )
  }

  get(sessionId: string): SessionRuntimeActor<TBindings> | null {
    return this.actors.get(String(sessionId)) ?? null
  }

  snapshot(): SessionRuntimeActorSnapshot[] {
    return [...this.actors.values()]
      .map((actor) => actor.snapshot())
      .sort((a, b) => a.lastUsed - b.lastUsed)
  }

  listActors(): readonly SessionRuntimeActor<TBindings>[] {
    return [...this.actors.values()]
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const actor = this.actors.get(String(sessionId))
    if (!actor) return false
    await actor.close()
    this.actors.delete(actor.sessionId)
    return true
  }

  async close(): Promise<void> {
    await Promise.all([...this.actors.values()].map((actor) => actor.close()))
    this.actors.clear()
  }

  private idleEvictionCandidate(): SessionRuntimeActor<TBindings> | null {
    if (this.actors.size < this.maxActiveActors) return null
    return (
      [...this.actors.values()]
        .filter((actor) => actor.idle)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0] ?? null
    )
  }

  private nextClock(): number {
    this.logicalClock += 1
    return this.logicalClock
  }
}

const ALLOWED_TRANSITIONS: Record<
  SessionRuntimeCommandState,
  ReadonlySet<SessionRuntimeCommandState>
> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

function isTerminal(state: SessionRuntimeCommandState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

function normalizedId(value: string, label: string): string {
  const id = String(value ?? '').trim()
  if (!id) throw new Error(`${label} is required`)
  return id
}

function publicInterjection<TPayload>(
  receipt: InterjectionReceipt<TPayload>,
): SessionInterjection<TPayload> {
  return {
    id: receipt.id,
    targetCommandId: receipt.targetCommandId,
    payload: receipt.payload,
    state: receipt.state,
    reason: receipt.reason,
  }
}
