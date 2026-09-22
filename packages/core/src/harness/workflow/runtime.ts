/**
 * Worker-side script execution (ported from dsh-workflow-worker-thread
 * `runtime.ts`): per-run vm hooks, child RPC, concurrency/caps, cancellation,
 * and result serialization.
 *
 * Fatal workflow errors — bad hook arguments, unsupported schemas/options,
 * caps, start failures, and cancellation — propagate through combinators. Only
 * child failures and ordinary stage errors become per-item nulls. Every
 * returned promise has a rejection consumer so dropped script promises cannot
 * kill the worker. A cancelled script that never settles emits nothing; the
 * host force-settles the run within grace and terminates the thread.
 *
 * SELF-CONTAINED factory ({@link createExecutionKit}): serialized into the
 * worker source, so everything it needs arrives through `deps`.
 */

import type * as Vm from 'node:vm'
import type { JsonSchemaKit, ObjectJsonSchema } from '../tools/json-schema'
import type { RealmKit } from './realm'
import type {
  ChildHandle,
  ChildPort,
  WorkerLimits,
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowErrorCode,
  WorkflowMeta,
  WorkflowResult,
} from './types'

/** The observers the execution reports progress through. */
export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
}

export interface WorkerWorkflowErrorLike extends Error {
  readonly code: WorkflowErrorCode
  readonly fatal: boolean
}

/** One live script execution; `drive()` is called once and never rejects. */
export interface WorkflowExecutionLike {
  cancel(reason: string): void
  drive(): Promise<WorkflowResult>
}

export interface ExecutionKit {
  WorkflowError: new (
    message: string,
    code: WorkflowErrorCode,
    options?: { cause?: unknown; fatal?: boolean },
  ) => WorkerWorkflowErrorLike
  isFatalWorkflowError(error: unknown): boolean
  createExecution(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    limits: WorkerLimits,
    observer: ExecutionObserver,
    children: ChildPort,
  ): WorkflowExecutionLike
}

export interface ExecutionKitDeps {
  vm: typeof Vm
  realm: RealmKit
  schema: JsonSchemaKit
}

/** Build the execution kit. SELF-CONTAINED (serialized into the worker source). */
export function createExecutionKit(deps: ExecutionKitDeps): ExecutionKit {
  const { vm, realm, schema: jsonSchema } = deps
  const { materializeFromRealm, MaterializeError, renderThrown } = realm

  class WorkflowError extends Error implements WorkerWorkflowErrorLike {
    readonly code: WorkflowErrorCode
    readonly fatal: boolean

    constructor(
      message: string,
      code: WorkflowErrorCode,
      options?: { cause?: unknown; fatal?: boolean },
    ) {
      super(
        message,
        options?.cause === undefined ? undefined : { cause: options.cause },
      )
      this.name = 'WorkflowError'
      this.code = code
      this.fatal = options?.fatal ?? true
    }
  }

  const isFatalWorkflowError = (error: unknown): boolean =>
    error instanceof WorkflowError && error.fatal

  const SUPPORTED_AGENT_OPTIONS = new Set([
    'label',
    'phase',
    'schema',
    'provider',
    'model',
  ])
  const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

  const outputText = (
    blocks: Array<{ type: string; text?: unknown }>,
  ): string =>
    blocks
      .filter(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text as string)
      .join('')

  const defaultLabel = (prompt: string): string => {
    const newline = prompt.indexOf('\n')
    const line = newline === -1 ? prompt : prompt.slice(0, newline)
    return line.length <= 48 ? line : `${line.slice(0, 47)}…`
  }

  class WorkflowExecution implements WorkflowExecutionLike {
    private started: number
    private activeSlots: number
    private readonly slotWaiters: Array<{
      resolve(): void
      reject(error: unknown): void
    }>
    private cancelReason: string | undefined
    private cancelError: WorkflowError | undefined
    private currentPhase: string | undefined
    private readonly context: Vm.Context
    private readonly compiled: Vm.Script
    private readonly limits: WorkerLimits
    private readonly observer: ExecutionObserver
    private readonly children: ChildPort

    constructor(
      meta: WorkflowMeta,
      body: string,
      args: unknown,
      limits: WorkerLimits,
      observer: ExecutionObserver,
      children: ChildPort,
    ) {
      this.started = 0
      this.activeSlots = 0
      this.slotWaiters = []
      this.cancelReason = undefined
      this.cancelError = undefined
      this.currentPhase = undefined
      this.limits = limits
      this.observer = observer
      this.children = children
      // Compile FIRST: a body syntax error throws before any realm state exists.
      // lineOffset compensates for the wrapper line.
      try {
        this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
          filename: `workflow:${meta.name}`,
          lineOffset: -1,
        })
      } catch (error: unknown) {
        throw new WorkflowError(
          `workflow script does not parse: ${String(error)}`,
          'SCRIPT_PARSE',
          { cause: error },
        )
      }
      this.context = vm.createContext({}, { name: `workflow:${meta.name}` })
      const globals: Record<string, unknown> = {
        agent: (prompt: unknown, opts?: unknown) =>
          this.contain(this.agent(prompt, opts)),
        parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
        pipeline: (items: unknown, ...stages: unknown[]) =>
          this.contain(this.pipeline(items, stages)),
        phase: (title: unknown) => {
          this.phase(title)
        },
        log: (message: unknown) => {
          this.log(message)
        },
        // workerData already performed the real cross-thread structured clone.
        args,
      }
      for (const [key, value] of Object.entries(globals)) {
        ;(this.context as Record<string, unknown>)[key] =
          typeof value === 'function' ? Object.freeze(value) : value
      }
    }

    /** A method, not an inline read: `cancel()` mutates state concurrently. */
    private isCancelled(): boolean {
      return this.cancelReason !== undefined
    }

    private throwIfCancelled(): void {
      if (this.isCancelled()) throw this.cancelledError()
    }

    cancel(reason: string): void {
      if (this.cancelReason !== undefined) return
      this.cancelReason = reason
      this.cancelError = new WorkflowError(
        `workflow run cancelled: ${reason}`,
        'CANCELLED',
      )
      for (const waiter of this.slotWaiters.splice(0))
        waiter.reject(this.cancelledError())
    }

    async drive(): Promise<WorkflowResult> {
      try {
        if (this.isCancelled()) throw this.cancelledError()
        const scriptPromise = this.compiled.runInContext(this.context, {
          timeout: this.limits.syncTimeoutMs,
        }) as Promise<unknown>
        const raw: unknown = await this.contain(Promise.resolve(scriptPromise))
        if (this.isCancelled()) throw this.cancelledError()
        const value = raw === undefined ? null : this.materializeResult(raw)
        return {
          value,
          stopReason: 'completed',
          agentsStarted: this.started,
        }
      } catch (error: unknown) {
        if (this.isCancelled()) {
          return {
            value: null,
            stopReason: 'cancelled',
            error: this.cancelledError().message,
            agentsStarted: this.started,
          }
        }
        return {
          value: null,
          stopReason: 'error',
          error: renderThrown(error),
          agentsStarted: this.started,
        }
      }
    }

    /** Attach a no-op rejection consumer without changing what the caller receives. */
    private contain<T>(promise: Promise<T>): Promise<T> {
      promise.catch(() => {})
      return promise
    }

    private cancelledError(): WorkflowError {
      return (
        this.cancelError ??
        new WorkflowError('workflow run cancelled', 'CANCELLED')
      )
    }

    private materializeResult(raw: unknown): unknown {
      try {
        return materializeFromRealm(raw, 'workflow result')
      } catch (error: unknown) {
        if (!(error instanceof MaterializeError)) throw error
        throw new WorkflowError(
          `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
          'RESULT_UNSERIALIZABLE',
          { cause: error },
        )
      }
    }

    private acquireSlot(): Promise<void> {
      if (this.activeSlots < this.limits.maxConcurrentAgents) {
        this.activeSlots += 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        this.slotWaiters.push({
          resolve: () => {
            this.activeSlots += 1
            resolve()
          },
          reject,
        })
      })
    }

    private releaseSlot(): void {
      this.activeSlots -= 1
      const next = this.slotWaiters.shift()
      if (next) next.resolve()
    }

    private async agent(
      rawPrompt: unknown,
      rawOpts: unknown,
    ): Promise<unknown> {
      this.throwIfCancelled()
      if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
        throw new WorkflowError(
          'agent() requires a non-empty prompt string',
          'INVALID_ARGUMENT',
        )
      }
      const opts = this.readAgentOptions(rawOpts)
      if (this.started >= this.limits.maxTotalAgents) {
        throw new WorkflowError(
          `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
          'AGENT_CAP',
        )
      }
      this.started += 1
      const seq = this.started
      const label = opts.label ?? defaultLabel(rawPrompt)
      const phase = opts.phase ?? this.currentPhase

      await this.acquireSlot()
      try {
        // A cancel landing during the acquire must not reach the host.
        this.throwIfCancelled()
        let run: ChildHandle
        try {
          run = await this.children.startAgent({
            prompt: rawPrompt,
            label,
            ...(opts.schema === undefined ? {} : { schema: opts.schema }),
            ...(opts.provider === undefined ? {} : { provider: opts.provider }),
            ...(opts.model === undefined ? {} : { model: opts.model }),
          })
        } catch (error: unknown) {
          if (this.isCancelled()) throw this.cancelledError()
          throw new WorkflowError(
            `agent() could not start a child: ${renderThrown(error)}`,
            'AGENT_START',
            { cause: error },
          )
        }
        if (this.isCancelled()) {
          await run.dispose()
          throw this.cancelledError()
        }
        const info: WorkflowAgentInfo = {
          seq,
          label,
          ...(phase === undefined ? {} : { phase }),
          childId: run.id,
        }
        this.observer.agentStart(info)
        try {
          let result
          try {
            result = await run.result
          } catch (error: unknown) {
            // An INFRASTRUCTURE fault relayed by the host: pair, then propagate fatal.
            if (this.isCancelled()) {
              this.observer.agentEnd({ ...info, outcome: 'cancelled' })
              throw this.cancelledError()
            }
            this.observer.agentEnd({ ...info, outcome: 'failed' })
            throw new WorkflowError(
              `child agent run failed: ${renderThrown(error)}`,
              'AGENT_RESULT',
              { cause: error },
            )
          }
          if (result.stopReason === 'completed') {
            if (opts.schema !== undefined) {
              if (result.structured === undefined) {
                this.observer.agentEnd({ ...info, outcome: 'failed' })
                return null
              }
              this.observer.agentEnd({ ...info, outcome: 'completed' })
              return result.structured
            }
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            return outputText(result.output)
          }
          if (this.isCancelled()) {
            this.observer.agentEnd({ ...info, outcome: 'cancelled' })
            throw this.cancelledError()
          }
          this.observer.agentEnd({ ...info, outcome: 'failed' })
          return null
        } finally {
          await run.dispose()
        }
      } finally {
        this.releaseSlot()
      }
    }

    private readAgentOptions(rawOpts: unknown): {
      label?: string
      phase?: string
      provider?: string
      model?: string
      schema?: ObjectJsonSchema
    } {
      if (rawOpts === undefined) return {}
      let opts: unknown
      try {
        opts = materializeFromRealm(rawOpts, 'agent() options')
      } catch (error: unknown) {
        if (!(error instanceof MaterializeError)) throw error
        throw new WorkflowError(
          `agent() options must be plain JSON data — ${error.message}`,
          'INVALID_ARGUMENT',
          { cause: error },
        )
      }
      if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
        throw new WorkflowError(
          'agent() options must be an object',
          'INVALID_ARGUMENT',
        )
      }
      const record = opts as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
        if (DEFERRED_AGENT_OPTIONS.has(key)) {
          throw new WorkflowError(
            `agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)`,
            'UNSUPPORTED_OPTION',
          )
        }
        throw new WorkflowError(
          `agent() option "${key}" is not recognized (supported: label, phase, schema, provider, model)`,
          'UNSUPPORTED_OPTION',
        )
      }
      for (const key of ['label', 'phase', 'provider', 'model']) {
        if (record[key] !== undefined && typeof record[key] !== 'string') {
          throw new WorkflowError(
            `agent() option "${key}" must be a string`,
            'INVALID_ARGUMENT',
          )
        }
      }
      let schema: ObjectJsonSchema | undefined
      if (record.schema !== undefined) {
        try {
          const assertObject: JsonSchemaKit['assertObjectJsonSchema'] =
            jsonSchema.assertObjectJsonSchema
          assertObject(record.schema)
          schema = record.schema
        } catch (error: unknown) {
          if (!(error instanceof jsonSchema.JsonSchemaError)) throw error
          throw new WorkflowError(
            `agent() schema is outside the supported subset — ${error.message}`,
            'UNSUPPORTED_SCHEMA',
            { cause: error },
          )
        }
      }
      return {
        ...(record.label === undefined
          ? {}
          : { label: record.label as string }),
        ...(record.phase === undefined
          ? {}
          : { phase: record.phase as string }),
        ...(record.provider === undefined
          ? {}
          : { provider: record.provider as string }),
        ...(record.model === undefined
          ? {}
          : { model: record.model as string }),
        ...(schema === undefined ? {} : { schema }),
      }
    }

    private async parallel(rawThunks: unknown): Promise<unknown[]> {
      this.throwIfCancelled()
      if (!Array.isArray(rawThunks)) {
        throw new WorkflowError(
          'parallel() requires an array of zero-argument functions',
          'INVALID_ARGUMENT',
        )
      }
      this.assertItemCap(rawThunks.length, 'parallel()')
      const thunks = rawThunks.map((thunk: unknown, index) => {
        if (typeof thunk !== 'function') {
          throw new WorkflowError(
            `parallel() item ${index} is not a function`,
            'INVALID_ARGUMENT',
          )
        }
        return thunk as () => unknown
      })
      return Promise.all(
        thunks.map(async (thunk) => {
          try {
            return await thunk()
          } catch (error: unknown) {
            // Fatality is `instanceof` against THIS realm's class: unforgeable from the script.
            if (isFatalWorkflowError(error)) throw error
            return null
          }
        }),
      )
    }

    private async pipeline(
      rawItems: unknown,
      rawStages: unknown[],
    ): Promise<unknown[]> {
      this.throwIfCancelled()
      if (!Array.isArray(rawItems)) {
        throw new WorkflowError(
          'pipeline() requires an items array',
          'INVALID_ARGUMENT',
        )
      }
      this.assertItemCap(rawItems.length, 'pipeline()')
      if (rawStages.length === 0) {
        throw new WorkflowError(
          'pipeline() requires at least one stage function',
          'INVALID_ARGUMENT',
        )
      }
      const stages = rawStages.map((stage, index) => {
        if (typeof stage !== 'function') {
          throw new WorkflowError(
            `pipeline() stage ${index} is not a function`,
            'INVALID_ARGUMENT',
          )
        }
        return stage as (
          previous: unknown,
          item: unknown,
          index: number,
        ) => unknown
      })
      return Promise.all(
        rawItems.map(async (item: unknown, index) => {
          let value: unknown = item
          try {
            for (const stage of stages) value = await stage(value, item, index)
            return value
          } catch (error: unknown) {
            if (isFatalWorkflowError(error)) throw error
            return null
          }
        }),
      )
    }

    private assertItemCap(length: number, hook: string): void {
      if (length > this.limits.maxItemsPerCall) {
        throw new WorkflowError(
          `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
          'ITEM_CAP',
        )
      }
    }

    private phase(title: unknown): void {
      this.throwIfCancelled()
      if (typeof title !== 'string' || title.length === 0) {
        throw new WorkflowError(
          'phase() requires a non-empty title string',
          'INVALID_ARGUMENT',
        )
      }
      this.currentPhase = title
      this.observer.phase(title)
    }

    private log(message: unknown): void {
      this.throwIfCancelled()
      if (typeof message !== 'string') {
        throw new WorkflowError(
          'log() requires a message string',
          'INVALID_ARGUMENT',
        )
      }
      this.observer.log(message)
    }
  }

  return {
    WorkflowError,
    isFatalWorkflowError,
    createExecution: (meta, body, args, limits, observer, children) =>
      new WorkflowExecution(meta, body, args, limits, observer, children),
  }
}
