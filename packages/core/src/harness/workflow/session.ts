/**
 * Worker-side half of the engine (ported from dsh-workflow-worker-thread
 * `session.ts`): `runWorkerSession` wires one MessagePort to one execution —
 * hook progress and child starts go out as messages, run control and child
 * lifecycle come back in — and posts the terminal result exactly once.
 *
 * The session announces `ready` and waits for `go`, so a cancellation racing
 * startup can prevent even the script's synchronous prefix. A cancel in place
 * of `go` releases the gate into a cancelled drive without executing the body.
 *
 * SELF-CONTAINED factory ({@link createSessionKit}): serialized into the
 * worker source. Tests drive it in-process over a `MessageChannel`.
 */

import type { MessagePort } from 'node:worker_threads'
import type { RealmKit } from './realm'
import type {
  ExecutionKit,
  ExecutionObserver,
  WorkflowExecutionLike,
} from './runtime'
import type {
  ChildHandle,
  ChildPort,
  ChildResult,
  ChildStartRequest,
  HostToWorkerMessage,
  WorkerInit,
  WorkerToHostMessage,
} from './types'

export interface SessionKit {
  /**
   * Run one workflow script to settlement against `port`, posting the terminal
   * `result` exactly once. Never rejects.
   */
  runWorkerSession(port: MessagePort, init: WorkerInit): Promise<void>
}

export interface SessionKitDeps {
  execution: ExecutionKit
  realm: RealmKit
}

/** Build the session kit. SELF-CONTAINED (serialized into the worker source). */
export function createSessionKit(deps: SessionKitDeps): SessionKit {
  const { execution, realm } = deps

  interface Deferred<T> {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
  }
  const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  interface PendingChild {
    started: Deferred<string>
    settled: Deferred<ChildResult>
    disposed: Deferred<void>
  }

  type Post = (message: WorkerToHostMessage) => void

  /** The worker-side child-RPC bridge. */
  const createBridge = (
    post: Post,
  ): ChildPort & {
    onChildStarted(callId: number, childId: string): void
    onChildStartError(callId: number, rendered: string): void
    onChildSettled(callId: number, result: ChildResult): void
    onChildFailed(callId: number, rendered: string): void
    onChildDisposed(callId: number): void
  } => {
    let nextCallId = 0
    const pending = new Map<number, PendingChild>()
    return {
      async startAgent(request: ChildStartRequest): Promise<ChildHandle> {
        nextCallId += 1
        const callId = nextCallId
        const entry: PendingChild = {
          started: deferred<string>(),
          settled: deferred<ChildResult>(),
          disposed: deferred<void>(),
        }
        // A settlement nobody consumes (failed start, teardown) must not kill the worker.
        entry.settled.promise.catch(() => {})
        pending.set(callId, entry)
        post({ type: 'child-start', callId, request })
        const childId = await entry.started.promise
        return {
          id: childId,
          result: entry.settled.promise,
          dispose: () => {
            post({ type: 'child-dispose', callId })
            return entry.disposed.promise
          },
        }
      },
      onChildStarted(callId, childId) {
        pending.get(callId)?.started.resolve(childId)
      },
      onChildStartError(callId, rendered) {
        const entry = pending.get(callId)
        pending.delete(callId)
        entry?.started.reject(new Error(rendered))
      },
      onChildSettled(callId, result) {
        pending.get(callId)?.settled.resolve(result)
      },
      onChildFailed(callId, rendered) {
        pending.get(callId)?.settled.reject(new Error(rendered))
      },
      onChildDisposed(callId) {
        const entry = pending.get(callId)
        pending.delete(callId)
        entry?.disposed.resolve(undefined)
      },
    }
  }

  const runWorkerSession = async (
    port: MessagePort,
    init: WorkerInit,
  ): Promise<void> => {
    const post: Post = (message) => {
      port.postMessage(message)
    }
    const children = createBridge(post)
    const observer: ExecutionObserver = {
      phase: (title) => {
        post({ type: 'phase', title })
      },
      log: (message) => {
        post({ type: 'log', message })
      },
      agentStart: (info) => {
        post({ type: 'agent-start', info })
      },
      agentEnd: (info) => {
        post({ type: 'agent-end', info })
      },
    }
    let run: WorkflowExecutionLike
    try {
      run = execution.createExecution(
        init.meta,
        init.body,
        init.args,
        init.limits,
        observer,
        children,
      )
    } catch (error: unknown) {
      post({
        type: 'result',
        result: {
          value: null,
          stopReason: 'error',
          error: realm.renderThrown(error),
          agentsStarted: 0,
        },
      })
      return
    }
    const gate = deferred<void>()
    port.on('message', (message: HostToWorkerMessage) => {
      switch (message.type) {
        case 'go':
          gate.resolve(undefined)
          break
        case 'cancel':
          run.cancel(message.reason)
          // A cancel doubles as the gate release: drive() then never runs the body.
          gate.resolve(undefined)
          break
        case 'child-started':
          children.onChildStarted(message.callId, message.childId)
          break
        case 'child-start-error':
          children.onChildStartError(message.callId, message.rendered)
          break
        case 'child-settled':
          children.onChildSettled(message.callId, message.result)
          break
        case 'child-failed':
          children.onChildFailed(message.callId, message.rendered)
          break
        case 'child-disposed':
          children.onChildDisposed(message.callId)
          break
        default:
          break
      }
    })
    post({ type: 'ready' })
    await gate.promise
    const result = await run.drive()
    post({ type: 'result', result })
  }

  return { runWorkerSession }
}
