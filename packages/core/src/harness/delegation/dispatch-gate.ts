import { DelegationError, type ExternalBackend } from './types'

const NAMES: Record<ExternalBackend, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/**
 * While an executor is upgraded it takes no new delegations (AGT-13): an
 * upgrade `hold`s it from the confirmation on, so a new start is refused at
 * once, and the subtasks already running finish first (the upgrade waits
 * for them). While the command runs (`installing`), a follow-up run of an
 * existing delegation waits in `settled`. Each hold is released once.
 */
export class ExecutorDispatchGate {
  private readonly holds = new Map<
    ExternalBackend,
    { count: number; installing: boolean; waiters: Set<() => void> }
  >()
  hold(backend: ExternalBackend): void {
    const hold = this.holds.get(backend)
    if (hold) hold.count++
    else
      this.holds.set(backend, {
        count: 1,
        installing: false,
        waiters: new Set(),
      })
  }
  installing(backend: ExternalBackend, on = true): void {
    const hold = this.holds.get(backend)
    if (!hold) return
    hold.installing = on
    if (!on) this.wake(hold)
  }
  release(backend: ExternalBackend): void {
    const hold = this.holds.get(backend)
    if (!hold || --hold.count > 0) return
    this.holds.delete(backend)
    this.wake(hold)
  }
  private wake(hold: { waiters: Set<() => void> }) {
    const waiters = [...hold.waiters]
    hold.waiters.clear()
    for (const wake of waiters) wake()
  }
  /** Why a new delegation to it is refused now. */
  refused(backend: ExternalBackend): string | undefined {
    return this.holds.has(backend)
      ? `${NAMES[backend]} is being upgraded; it takes new subtasks once the upgrade ends`
      : undefined
  }
  /** Resolves once its upgrade command is not running. */
  settled(backend: ExternalBackend, signal?: AbortSignal): Promise<void> {
    const hold = this.holds.get(backend)
    if (!hold?.installing) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        hold.waiters.delete(wake)
        reject(new DelegationError('ABORTED', 'stopped while an upgrade ran'))
      }
      if (signal?.aborted) return abort()
      hold.waiters.add(wake)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
