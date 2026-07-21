export interface ActionEffectDescriptor {
  id: string
  key: string
  timeoutMs?: number
}

export type ActionEffectTaskStatus =
  'success' | 'error' | 'cancelled' | 'timeout'

export interface ActionEffectTaskResult<
  Effect extends ActionEffectDescriptor,
  Output,
> {
  effect: Effect
  status: ActionEffectTaskStatus
  output?: Output
  error?: { name: string; message: string }
}

export interface ActionEffectTransition<State, Effect, Meta = unknown> {
  state: State
  effects: Effect[]
  meta?: Meta
}

export interface ActionEffectStoreOptions<
  State,
  Action,
  Effect extends ActionEffectDescriptor,
  Output,
  Meta = unknown,
> {
  initialState: State
  reducer: (
    state: State,
    action: Action,
  ) => ActionEffectTransition<State, Effect, Meta>
  execute: (effect: Effect, signal: AbortSignal) => Output | Promise<Output>
  taskResultAction: (result: ActionEffectTaskResult<Effect, Output>) => Action
  onStateChange?: (state: State, action: Action) => void
}

interface RunningEffect<Effect extends ActionEffectDescriptor> {
  effect: Effect
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
}

/**
 * Small domain-local Action → Effect → TaskResult loop. Reducers stay pure;
 * async work is cancellable, deadline bounded, and can only change state by
 * dispatching its typed terminal result back through the reducer.
 */
export class ActionEffectStore<
  State,
  Action,
  Effect extends ActionEffectDescriptor,
  Output,
  Meta = unknown,
> {
  private state: State
  private readonly reducer: ActionEffectStoreOptions<
    State,
    Action,
    Effect,
    Output,
    Meta
  >['reducer']
  private readonly execute: ActionEffectStoreOptions<
    State,
    Action,
    Effect,
    Output,
    Meta
  >['execute']
  private readonly taskResultAction: ActionEffectStoreOptions<
    State,
    Action,
    Effect,
    Output,
    Meta
  >['taskResultAction']
  private readonly onStateChange?: ActionEffectStoreOptions<
    State,
    Action,
    Effect,
    Output,
    Meta
  >['onStateChange']
  private readonly runningById = new Map<string, RunningEffect<Effect>>()
  private readonly runningByKey = new Map<string, RunningEffect<Effect>>()
  private disposed = false

  constructor(
    options: ActionEffectStoreOptions<State, Action, Effect, Output, Meta>,
  ) {
    this.state = options.initialState
    this.reducer = options.reducer
    this.execute = options.execute
    this.taskResultAction = options.taskResultAction
    this.onStateChange = options.onStateChange
  }

  getState(): State {
    return this.state
  }

  pendingCount(): number {
    return this.runningById.size
  }

  dispatch(action: Action): ActionEffectTransition<State, Effect, Meta> {
    if (this.disposed) return { state: this.state, effects: [] }
    const transition = this.reducer(this.state, action)
    this.state = transition.state
    this.onStateChange?.(this.state, action)
    for (const effect of transition.effects) this.start(effect)
    return transition
  }

  cancel(key: string): boolean {
    const running = this.runningByKey.get(key)
    if (!running) return false
    this.settle(running, 'cancelled')
    return true
  }

  dispose(): void {
    if (this.disposed) return
    for (const running of [...this.runningById.values()])
      this.settle(running, 'cancelled')
    this.disposed = true
  }

  private start(effect: Effect): void {
    const existing = this.runningByKey.get(effect.key)
    if (existing) this.settle(existing, 'cancelled')

    const running: RunningEffect<Effect> = {
      effect,
      controller: new AbortController(),
      timer: null,
      settled: false,
    }
    this.runningById.set(effect.id, running)
    this.runningByKey.set(effect.key, running)

    const timeoutMs = boundedTimeout(effect.timeoutMs)
    if (timeoutMs !== null) {
      running.timer = setTimeout(
        () => this.settle(running, 'timeout'),
        timeoutMs,
      )
    }

    try {
      const output = this.execute(effect, running.controller.signal)
      if (isPromiseLike<Output>(output)) {
        void output.then(
          (value) => this.settle(running, 'success', value),
          (error) => this.settle(running, 'error', undefined, error),
        )
      } else {
        this.settle(running, 'success', output)
      }
    } catch (error) {
      this.settle(running, 'error', undefined, error)
    }
  }

  private settle(
    running: RunningEffect<Effect>,
    status: ActionEffectTaskStatus,
    output?: Output,
    error?: unknown,
  ): void {
    if (running.settled) return
    running.settled = true
    if (running.timer) clearTimeout(running.timer)
    if (status === 'cancelled' || status === 'timeout')
      running.controller.abort(status)
    if (this.runningById.get(running.effect.id) === running)
      this.runningById.delete(running.effect.id)
    if (this.runningByKey.get(running.effect.key) === running)
      this.runningByKey.delete(running.effect.key)

    const result: ActionEffectTaskResult<Effect, Output> = {
      effect: running.effect,
      status,
      ...(status === 'success' ? { output } : {}),
      ...(status === 'error' ? { error: serializeError(error) } : {}),
    }
    this.dispatch(this.taskResultAction(result))
  }
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function',
  )
}

function boundedTimeout(value: number | undefined): number | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null
  return Math.max(1, Math.round(Number(value)))
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error)
    return {
      name: error.name || 'Error',
      message: error.message.slice(0, 500),
    }
  return { name: 'Error', message: String(error).slice(0, 500) }
}
