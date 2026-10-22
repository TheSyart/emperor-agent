import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  DelegationResources,
  type ResourceLease,
} from '../harness/delegation/resources'

export interface WorkspaceMutationHost {
  runExclusive<T>(
    workspaceRoot: string,
    owner: 'agent' | 'renderer_git',
    action: () => Promise<T>,
    signal?: AbortSignal | null,
  ): Promise<T>
}

/** A write waits this long for a child's workspace before it says so (AGT-06). */
export const WORKSPACE_WAIT_NOTICE_MS = 10_000

/** Agent tools and trusted Renderer Git actions share one Core-owned queue. */
export class WorkspaceMutationCoordinator implements WorkspaceMutationHost {
  private readonly tails = new Map<string, Promise<void>>()
  constructor(readonly resources = new DelegationResources()) {}
  hasActiveWriter(root: string, exceptOwner?: string): boolean {
    return this.resources.hasActive(workspaceMutationDomain(root), exceptOwner)
  }
  acquireWriter(
    root: string,
    owner: string,
    signal?: AbortSignal | null,
  ): Promise<ResourceLease> {
    return this.resources.acquire(
      { keys: [workspaceMutationDomain(root)], mode: 'shared', owner },
      signal,
    )
  }

  /**
   * A main-session write's lease (AGT-06): it waits for an exclusive holder
   * (a subagent working in the folder itself), ends when `signal` aborts,
   * and after `noticeMs` tells `onWait` who it waits for; the function
   * `onWait` returns runs when the wait ends, however it ends.
   */
  async acquireWriterWithNotice(
    root: string,
    owner: string,
    options: {
      signal?: AbortSignal | null
      keys?: string[]
      noticeMs?: number
      onWait?: (blockers: string[]) => (() => void) | void
    } = {},
  ): Promise<ResourceLease> {
    const keys = options.keys ?? [workspaceMutationDomain(root)]
    let ended: (() => void) | undefined
    const timer = options.onWait
      ? setTimeout(() => {
          const blockers = this.resources.blockers({ keys, mode: 'shared' })
          if (blockers.length) ended = options.onWait!(blockers) ?? undefined
        }, options.noticeMs ?? WORKSPACE_WAIT_NOTICE_MS)
      : undefined
    try {
      return await this.resources.acquire(
        { keys, mode: 'shared', owner },
        options.signal,
      )
    } finally {
      clearTimeout(timer)
      ended?.()
    }
  }

  async runExclusive<T>(
    workspaceRoot: string,
    _owner: 'agent' | 'renderer_git',
    action: () => Promise<T>,
    signal?: AbortSignal | null,
  ): Promise<T> {
    const key = workspaceMutationDomain(workspaceRoot)
    const lease = await this.resources.acquire(
      { keys: [key], mode: 'exclusive', owner: _owner },
      signal,
    )
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.tails.set(key, tail)
    try {
      await waitForPredecessor(previous, signal)
      throwIfAborted(signal)
      return await action()
    } finally {
      release()
      lease.release()
      // A cancelled waiter releases its own gate immediately, but its tail still
      // represents the running predecessor. Keep that tail discoverable until
      // the whole chain settles so a later mutation cannot overtake it.
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key)
      })
    }
  }
}

/** Sibling projects inside one Git worktree must share the same mutation lease. */
export function workspaceMutationDomain(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot)
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute
  let current = canonical
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return canonical
    current = parent
  }
}

async function waitForPredecessor(
  predecessor: Promise<void>,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!signal) {
    await predecessor.catch(() => undefined)
    return
  }
  throwIfAborted(signal)
  let removeAbortListener: () => void = () => undefined
  try {
    await Promise.race([
      predecessor.catch(() => undefined),
      new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      }),
    ])
  } finally {
    removeAbortListener()
  }
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
