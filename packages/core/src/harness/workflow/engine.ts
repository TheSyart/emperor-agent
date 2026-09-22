/**
 * The worker-thread workflow engine (ported from dsh-workflow
 * `WorkflowEngine` + dsh-workflow-worker-thread's engine service, without the
 * Cordis service/event plumbing: providers and observers are plain
 * constructor-injected objects).
 *
 * `start()` validates enough synchronously to reject a malformed meta block,
 * an unparseable body, an unavailable provider route, or an unsupported
 * per-run limit before a run exists; once a run is returned its `result`
 * never rejects. Each run executes the script in a fresh worker thread
 * (containment, not a security boundary) and bridges `agent()` calls back to
 * host child providers.
 */

import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import * as vm from 'node:vm'
import { logger } from '../../util/log'
import { WorkflowError } from './errors'
import { WorkerRun } from './host'
import { validateMeta } from './meta'
import { realm } from './realm'
import type {
  ChildProvider,
  WorkerInit,
  WorkerLimits,
  WorkflowEngineObserver,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
} from './types'

export interface WorkflowEngineConfig {
  /** The child provider `agent()` uses (default `spawn`). */
  provider?: string
  /** Concurrent `agent()` ceiling; `0` (default) resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by one `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** vm timeout for the script's initial synchronous slice (default 5000 ms). */
  syncTimeoutMs?: number
  /** Cancellation grace before force-settle + worker termination (default 5000 ms). */
  disposeGraceMs?: number
}

export const WORKFLOW_ENGINE_DEFAULTS: Required<WorkflowEngineConfig> = {
  provider: 'spawn',
  maxConcurrentAgents: 0,
  maxTotalAgents: 1000,
  maxItemsPerCall: 4096,
  syncTimeoutMs: 5000,
  disposeGraceMs: 5000,
}

/** A body that still carries the Claude Code-style meta header. */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/

/** Parse-check the body with the same wrapper the worker compiles. */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError(
      'workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body',
      'SCRIPT_PARSE',
    )
  }
  try {
    void new vm.Script(`(async () => {\n${body}\n})()`, {
      filename: `workflow:${name}`,
      lineOffset: -1,
    })
  } catch (error: unknown) {
    throw new WorkflowError(
      `workflow script does not parse: ${String(error)}`,
      'SCRIPT_PARSE',
      { cause: error },
    )
  }
}

function resolveMaxTotalAgents(
  requested: number | undefined,
  ceiling: number,
): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new WorkflowError(
      'workflow maxTotalAgents must be a positive safe integer',
      'INVALID_ARGUMENT',
    )
  if (requested > ceiling)
    throw new WorkflowError(
      `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`,
      'INVALID_ARGUMENT',
    )
  return requested
}

function positiveInteger(name: string, value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new TypeError(
      `workflow engine ${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`,
    )
}

export class WorkflowEngine {
  readonly config: Required<WorkflowEngineConfig>
  private readonly providers = new Map<string, ChildProvider>()
  private readonly observers = new Set<WorkflowEngineObserver>()

  constructor(
    providers: readonly ChildProvider[],
    config: WorkflowEngineConfig = {},
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.name))
        throw new Error(
          `workflow provider "${provider.name}" is registered twice`,
        )
      this.providers.set(provider.name, provider)
    }
    this.config = { ...WORKFLOW_ENGINE_DEFAULTS, ...config }
    positiveInteger(
      'maxConcurrentAgents',
      this.config.maxConcurrentAgents,
      true,
    )
    positiveInteger('maxTotalAgents', this.config.maxTotalAgents)
    positiveInteger('maxItemsPerCall', this.config.maxItemsPerCall)
    positiveInteger('syncTimeoutMs', this.config.syncTimeoutMs)
    positiveInteger('disposeGraceMs', this.config.disposeGraceMs, true)
  }

  getProvider(name: string): ChildProvider | undefined {
    return this.providers.get(name)
  }

  /** Observe run lifecycles; returns the unsubscribe. */
  observe(observer: WorkflowEngineObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  /**
   * Validate and execute a workflow script in a fresh worker thread. Throws
   * {@link WorkflowError} synchronously for a request that cannot begin.
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const providerName = request.subagentProvider ?? this.config.provider
    if (providerName.length === 0 || providerName !== providerName.trim())
      throw new WorkflowError(
        'workflow subagentProvider must be a non-empty normalized string',
        'INVALID_ARGUMENT',
      )
    const provider = this.providers.get(providerName)
    if (provider === undefined)
      throw new WorkflowError(
        `no subagent provider registered for "${providerName}"`,
        'AGENT_START',
      )
    const maxTotalAgents = resolveMaxTotalAgents(
      request.maxTotalAgents,
      this.config.maxTotalAgents,
    )
    const id = randomUUID()
    const info: WorkflowRunInfo = { id, meta }
    const limits: WorkerLimits = {
      maxConcurrentAgents:
        this.config.maxConcurrentAgents === 0
          ? Math.min(16, Math.max(1, availableParallelism() - 2))
          : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...(request.args === undefined ? {} : { args: request.args }),
      limits,
    }
    // Snapshot observers so a later unsubscribe cannot strand a run's pairing.
    const observers = [...this.observers]
    const emit = <K extends keyof WorkflowEngineObserver>(
      name: K,
      ...args: Parameters<NonNullable<WorkflowEngineObserver[K]>>
    ): void => {
      for (const observer of observers) {
        const callback = observer[name] as
          ((...payload: unknown[]) => unknown) | undefined
        if (callback === undefined) continue
        try {
          const returned = callback.apply(observer, args)
          void Promise.resolve(returned).catch((error: unknown) => {
            logger.warn(`workflow: ${name} listener rejected`, {
              error: realm.renderThrown(error),
            })
          })
        } catch (error: unknown) {
          logger.warn(`workflow: ${name} listener threw`, {
            error: realm.renderThrown(error),
          })
        }
      }
    }
    const run = new WorkerRun({
      id,
      meta,
      parent: request.parent,
      init,
      provider,
      disposeGraceMs: this.config.disposeGraceMs,
      observer: {
        phase: (title) => {
          emit('phase', info, title)
        },
        log: (message) => {
          emit('log', info, message)
        },
        agentStart: (agent) => {
          emit('agentStart', info, agent)
        },
        agentEnd: (agent) => {
          emit('agentEnd', info, agent)
        },
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.callId === undefined ? {} : { callId: request.callId }),
    })
    emit('start', info)
    void run.result.then((settled) => {
      emit('end', info, {
        stopReason: settled.stopReason,
        ...(settled.error === undefined ? {} : { error: settled.error }),
        agentsStarted: settled.agentsStarted,
      })
    })
    return run
  }
}
