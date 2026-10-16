import { DelegationError } from './types'
export interface ResourceLease {
  release(): void
}
export interface ResourceRequest {
  keys: string[]
  mode: 'shared' | 'exclusive'
  owner: string
}
interface Waiting {
  request: ResourceRequest
  resolve: (lease: ResourceLease) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal | null
  abort: () => void
}
function conflicts(a: ResourceRequest, b: ResourceRequest): boolean {
  return (
    (a.mode === 'exclusive' || b.mode === 'exclusive') &&
    a.keys.some((key) => b.keys.includes(key))
  )
}
/** Atomic acquisition over canonical, sorted keys. Queue fairness prevents writer starvation. */
export class DelegationResources {
  private readonly active = new Set<ResourceRequest>()
  private readonly waiting: Waiting[] = []
  hasActive(key: string, exceptOwner?: string): boolean {
    return [...this.active].some(
      (r) => r.keys.includes(key) && r.owner !== exceptOwner,
    )
  }
  acquire(
    request: ResourceRequest,
    signal?: AbortSignal | null,
  ): Promise<ResourceLease> {
    if (!request.owner || !request.keys.length || request.keys.some((k) => !k))
      return Promise.reject(
        new DelegationError(
          'INVALID_RESOURCE',
          'resource keys and owner are required',
        ),
      )
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException('Aborted', 'AbortError'),
      )
    const normalized = { ...request, keys: [...new Set(request.keys)].sort() }
    return new Promise((resolve, reject) => {
      const w: Waiting = {
        request: normalized,
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.waiting.indexOf(w)
          if (i >= 0) this.waiting.splice(i, 1)
          signal?.removeEventListener('abort', w.abort)
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          this.drain()
        },
      }
      this.waiting.push(w)
      signal?.addEventListener('abort', w.abort, { once: true })
      this.drain()
    })
  }
  private drain(): void {
    for (let i = 0; i < this.waiting.length;) {
      const w = this.waiting[i]!
      if (
        [...this.active].some((a) => conflicts(a, w.request)) ||
        this.waiting.slice(0, i).some((a) => conflicts(a.request, w.request))
      ) {
        i++
        continue
      }
      this.waiting.splice(i, 1)
      w.signal?.removeEventListener('abort', w.abort)
      this.active.add(w.request)
      let released = false
      w.resolve({
        release: () => {
          if (released) return
          released = true
          this.active.delete(w.request)
          this.drain()
        },
      })
    }
  }
}
