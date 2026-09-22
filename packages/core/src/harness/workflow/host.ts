/**
 * Host side of one workflow run (ported from dsh-workflow-worker-thread
 * `host.ts`). The first worker result, unexpected death, or cancellation-grace
 * expiry owns settlement and closes message admission. Pending child starts
 * share one abort signal; published children share idempotent cleanup, and
 * quiescence waits for both while synthesizing any missing end events.
 */

import { Worker } from 'node:worker_threads'
import { snapshotJsonValue } from '../../session-log/json'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import { realm } from './realm'
import type { ExecutionObserver } from './runtime'
import type {
  ChildProvider,
  ChildResult,
  ChildRun,
  ChildStartRequest,
  HostToWorkerMessage,
  WorkerInit,
  WorkerToHostMessage,
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
} from './types'
import { workflowWorkerSource } from './worker-source'

interface ChildRecord {
  readonly run: ChildRun
  disposal?: Promise<void>
}

/** The scrubbed worker environment: no ambient credentials (Windows keeps its temp path). */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tmp = process.env.TMP ?? process.env.TEMP,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32' && tmp !== undefined) {
    env.TMP = tmp
    env.TEMP = tmp
  }
  return env
}

export interface WorkerRunOptions {
  id: string
  meta: WorkflowMeta
  parent: Agent
  init: WorkerInit
  provider: ChildProvider
  disposeGraceMs: number
  observer: ExecutionObserver
  signal?: AbortSignal
  callId?: string
}

/**
 * One live worker-engine run. Owns the Worker, the child registry, and the
 * result settlement; `result` never rejects.
 */
export class WorkerRun implements WorkflowRun {
  readonly id: string
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  /** The first death signal closes worker-message admission. */
  private workerDeathObserved = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private readonly worker: Worker
  private workerGone = false
  /** Accepted `child-start` messages (the terminate-path `agentsStarted`). */
  private hostStarted = 0
  private readonly children = new Map<number, ChildRecord>()
  private readonly pendingStarts = new Set<Promise<void>>()
  /** Started-but-not-ended agents by seq: the pairing ledger the host guarantees. */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: Array<() => void> = []
  private readonly controller = new AbortController()
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined
  private readonly parent: Agent
  private readonly provider: ChildProvider
  private readonly disposeGraceMs: number
  private readonly observer: ExecutionObserver
  private readonly callId: string | undefined

  constructor(options: WorkerRunOptions) {
    this.id = options.id
    this.meta = options.meta
    this.parent = options.parent
    this.provider = options.provider
    this.disposeGraceMs = options.disposeGraceMs
    this.observer = options.observer
    this.callId = options.callId
    this.result = new Promise<WorkflowResult>((resolve) => {
      this.settleResolve = resolve
    })
    // workerData rides the structured clone: args are plain JSON by contract,
    // so the clone doubles as the caller-isolation copy.
    this.worker = new Worker(workflowWorkerSource(), {
      eval: true,
      workerData: options.init,
      env: workerSpawnEnv(),
      execArgv: [],
    })
    this.worker.on('message', (message: WorkerToHostMessage) => {
      this.onMessage(message)
    })
    this.worker.on('error', (error) => {
      this.onWorkerDeath(
        `workflow worker failed: ${realm.renderThrown(error)}`,
        false,
      )
    })
    this.worker.on('messageerror', (error) => {
      this.onWorkerDeath(
        `workflow worker message failed to deserialize: ${realm.renderThrown(error)}`,
        false,
      )
    })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(
        `workflow worker exited before the run settled (exit code ${code})`,
        true,
      )
    })
    const signal = options.signal
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /**
   * Cancel: the worker is told (hooks start throwing), the shared child signal
   * aborts, and the grace timer arms — a run still unsettled `disposeGraceMs`
   * later force-settles `cancelled` and its worker is terminated. Idempotent;
   * the first reason wins.
   */
  cancel(reason?: string): void {
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined)
      return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post({ type: 'cancel', reason: this.cancelReason })
    this.abortChildren(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      this.terminalClaimed = true
      this.endStrandedAgents()
      this.settleResult(this.cancelledResult(this.hostStarted))
      void this.worker.terminate()
    }, this.disposeGraceMs)
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + termination: host-drives every child's disposal
   * immediately, waits (at most the grace) for the result and child
   * quiescence, then terminates the worker unconditionally. Idempotent.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    let resolveClaim!: () => void
    let rejectClaim!: (error: unknown) => void
    this.disposed = new Promise<void>((resolve, reject) => {
      resolveClaim = resolve
      rejectClaim = reject
    })
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      this.reapChildren('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      await this.worker.terminate()
      this.reapChildren('workflow disposed')
    })().then(
      () => {
        resolveClaim()
      },
      (error: unknown) => {
        rejectClaim(error)
      },
    )
    return this.disposed
  }

  private post(message: HostToWorkerMessage): void {
    if (this.workerGone || this.workerDeathObserved) return
    try {
      this.worker.postMessage(message)
    } catch (error: unknown) {
      logger.warn('workflow: postMessage failed', {
        error: realm.renderThrown(error),
      })
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    // The first death signal is the logical delivery barrier.
    if (this.workerDeathObserved) return
    switch (message.type) {
      case 'ready':
        this.post({ type: 'go' })
        break
      case 'phase':
        // Nothing is narrated after cancel() returns.
        if (this.cancelReason === undefined) this.observer.phase(message.title)
        break
      case 'log':
        if (this.cancelReason === undefined) this.observer.log(message.message)
        break
      case 'agent-start':
        this.liveAgents.set(message.info.seq, message.info)
        this.observer.agentStart(message.info)
        break
      case 'agent-end':
        // Not suppressed on cancel: cancelled children report their paired end.
        this.endAgent(message.info)
        break
      case 'child-start':
        this.onChildStart(message.callId, message.request)
        break
      case 'child-dispose':
        this.onChildDispose(message.callId)
        break
      case 'result':
        this.onResult(message.result)
        break
      default:
        break
    }
  }

  private childAdmissionFailure(): { rendered: string } | undefined {
    if (this.cancelReason !== undefined)
      return { rendered: `workflow run cancelled: ${this.cancelReason}` }
    if (this.workerDeathObserved)
      return { rendered: 'workflow worker is no longer available' }
    if (this.terminalClaimed)
      return { rendered: 'workflow run already settled' }
    return undefined
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      this.post({
        type: 'child-start-error',
        callId,
        rendered: initialFailure.rendered,
      })
      return
    }
    this.hostStarted += 1
    const task = this.startChild(callId, request)
    this.pendingStarts.add(task)
    void task.then(
      () => {
        this.finishPendingStart(task)
      },
      () => {
        this.finishPendingStart(task)
      },
    )
  }

  private async startChild(
    callId: number,
    request: ChildStartRequest,
  ): Promise<void> {
    let run: ChildRun
    try {
      run = await this.provider.start({
        prompt: request.prompt,
        parent: this.parent,
        signal: this.controller.signal,
        ...(request.schema === undefined
          ? {}
          : { outputSchema: request.schema }),
        ...(request.provider === undefined
          ? {}
          : { provider: request.provider }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(this.callId === undefined ? {} : { callId: this.callId }),
      })
    } catch (error: unknown) {
      const failure = this.childAdmissionFailure()
      this.post({
        type: 'child-start-error',
        callId,
        rendered: failure?.rendered ?? realm.renderThrown(error),
      })
      return
    }
    const failure = this.childAdmissionFailure()
    if (failure !== undefined) {
      this.post({
        type: 'child-start-error',
        callId,
        rendered: failure.rendered,
      })
      try {
        await run.dispose()
      } catch (error: unknown) {
        logger.warn('workflow: refused child dispose failed', {
          error: realm.renderThrown(error),
        })
      }
      return
    }
    const record: ChildRecord = { run }
    this.children.set(callId, record)
    // Attach forwarding before publishing: ChildStarted is still posted first.
    const forwardResult = run.result.then<() => void, () => void>(
      (result) => {
        try {
          const snapshot = snapshotJsonValue<ChildResult>({
            output: result.output,
            ...(result.structured === undefined
              ? {}
              : { structured: result.structured }),
            stopReason: result.stopReason,
          })
          if (snapshot === undefined)
            throw new TypeError(
              'child result is not losslessly JSON-serializable',
            )
          return () => {
            this.post({ type: 'child-settled', callId, result: snapshot })
          }
        } catch (error: unknown) {
          const rendered = `workflow child result could not cross the worker boundary: ${realm.renderThrown(error)}`
          return () => {
            this.post({ type: 'child-failed', callId, rendered })
          }
        }
      },
      (error: unknown) => {
        const rendered = realm.renderThrown(error)
        return () => {
          this.post({ type: 'child-failed', callId, rendered })
        }
      },
    )
    this.post({ type: 'child-started', callId, childId: run.id })
    void forwardResult.then((forward) => {
      forward()
    })
  }

  private onChildDispose(callId: number): void {
    const record = this.children.get(callId)
    if (record === undefined) {
      this.post({ type: 'child-disposed', callId })
      return
    }
    void this.disposeChild(callId, record).then(() => {
      this.post({ type: 'child-disposed', callId })
    })
  }

  /** Start (or join) one child's memoized disposal; never rejects. */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        logger.warn('workflow: child dispose failed', {
          error: realm.renderThrown(error),
        })
      })
      .then(() => {
        this.children.delete(callId)
        this.notifyChildQuiescence()
      })
    return record.disposal
  }

  private finishPendingStart(task: Promise<void>): void {
    this.pendingStarts.delete(task)
    this.notifyChildQuiescence()
  }

  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0)
      return Promise.resolve()
    return new Promise((resolve) => {
      this.quiescenceWaiters.push(resolve)
    })
  }

  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason)
    for (const [callId, record] of [...this.children])
      void this.disposeChild(callId, record)
  }

  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private onResult(result: WorkflowResult): void {
    if (this.terminalClaimed) return
    const cancellationWasRequested = this.cancelReason !== undefined
    this.terminalClaimed = true
    // Abort pending starts and dispose strays before the run settles externally.
    this.reapChildren('workflow settled')
    if (!cancellationWasRequested) {
      this.settleResult(result)
      return
    }
    if (result.stopReason !== 'cancelled') {
      // The script settled while our cancel was crossing the thread boundary.
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0 || this.pendingStarts.size > 0)
        this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted))
        } else {
          this.settleResult({
            value: null,
            stopReason: 'error',
            error: message,
            agentsStarted: this.hostStarted,
          })
        }
      }
    }
    if (!isExit) return
    for (const [callId, record] of [...this.children])
      void this.disposeChild(callId, record)
    this.endStrandedAgents()
  }

  /** The single agent-end gate: forwards `end` iff its start is still unpaired. */
  private endAgent(end: WorkflowAgentEndInfo): void {
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /** Synthesize a cancelled end for every started-but-unpaired agent. */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()])
      this.endAgent({ ...info, outcome: 'cancelled' })
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    const reason = this.cancelReason ?? 'workflow cancelled'
    return {
      value: null,
      stopReason: 'cancelled',
      error: `workflow run cancelled: ${reason}`,
      agentsStarted,
    }
  }

  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  private settleResult(result: WorkflowResult): void {
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
