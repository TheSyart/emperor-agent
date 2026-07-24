import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface WorkspaceMutationHost {
  runExclusive<T>(
    workspaceRoot: string,
    owner: 'agent' | 'renderer_git',
    action: () => Promise<T>,
    signal?: AbortSignal | null,
  ): Promise<T>
}

/** Agent tools and trusted Renderer Git actions share one Core-owned queue. */
export class WorkspaceMutationCoordinator implements WorkspaceMutationHost {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<T>(
    workspaceRoot: string,
    _owner: 'agent' | 'renderer_git',
    action: () => Promise<T>,
    signal?: AbortSignal | null,
  ): Promise<T> {
    const key = mutationDomain(workspaceRoot)
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
function mutationDomain(workspaceRoot: string): string {
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
