import { sanitizeForWire } from '@emperor/core/api'
import {
  CORE_EVENT_CHANNEL,
  PET_EVENT_CHANNEL,
  SESSION_EVENT_CHANNEL,
  type SessionEventBatch,
} from '../shared/ipc-contract'
import { projectPetEvent } from './pet-event-projector'

export interface WebContentsLike {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

export class CoreEventBridge {
  private readonly targets = new Set<WebContentsLike>()
  private readonly petTargets = new Set<WebContentsLike>()

  attach(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.targets.add(webContents)
  }

  detach(webContents: WebContentsLike): void {
    this.targets.delete(webContents)
  }

  attachPet(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.petTargets.add(webContents)
  }

  detachPet(webContents: WebContentsLike): void {
    this.petTargets.delete(webContents)
  }

  emit(event: Record<string, unknown>): void {
    for (const target of [...this.targets]) {
      if (target.isDestroyed?.()) {
        this.targets.delete(target)
        continue
      }
      target.send(CORE_EVENT_CHANNEL, event)
    }
    const petEvent = projectPetEvent(event)
    if (!petEvent) return
    for (const target of [...this.petTargets]) {
      if (target.isDestroyed?.()) {
        this.petTargets.delete(target)
        continue
      }
      target.send(PET_EVENT_CHANNEL, petEvent)
    }
  }

  sink(): (event: Record<string, unknown>) => void {
    return (event) => this.emit(event)
  }

  size(): number {
    return this.targets.size
  }

  petSize(): number {
    return this.petTargets.size
  }
}

/** Default coalescing window for raw session events (one frame). */
export const SESSION_EVENT_BATCH_MS = 16

export interface SessionEventBridgeOptions {
  /** Whether the renderer watches a session (`sessions.watch`); default none. */
  isWatched?: (sessionId: string) => boolean
  /** Wire preparation applied to each forwarded event (default `sanitizeForWire`). */
  sanitize?: (event: unknown) => unknown
  batchMs?: number
}

/**
 * Forwards raw session-log events of watched sessions to renderer windows
 * on {@link SESSION_EVENT_CHANNEL}, separate from the projected UiEvent
 * stream. Events are coalesced per session for {@link SESSION_EVENT_BATCH_MS}
 * and sent as one `{ sessionId, events }` batch per session.
 */
export class SessionEventBridge {
  private readonly targets = new Set<WebContentsLike>()
  private readonly pending = new Map<string, unknown[]>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private isWatched: (sessionId: string) => boolean
  private readonly sanitize: (event: unknown) => unknown
  private readonly batchMs: number

  constructor(options: SessionEventBridgeOptions = {}) {
    this.isWatched = options.isWatched ?? (() => false)
    this.sanitize =
      options.sanitize ??
      ((event) =>
        sanitizeForWire(event as Parameters<typeof sanitizeForWire>[0]))
    this.batchMs = options.batchMs ?? SESSION_EVENT_BATCH_MS
  }

  attach(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.targets.add(webContents)
  }

  detach(webContents: WebContentsLike): void {
    this.targets.delete(webContents)
  }

  /** Bind the watch filter once CoreApi exists. */
  setWatchFilter(isWatched: (sessionId: string) => boolean): void {
    this.isWatched = isWatched
  }

  /** Queue one raw event; unwatched sessions are dropped immediately. */
  push(sessionId: string, event: unknown): void {
    if (this.targets.size === 0 || !this.isWatched(sessionId)) return
    const queue = this.pending.get(sessionId)
    const wire = this.sanitize(event)
    if (queue === undefined) this.pending.set(sessionId, [wire])
    else queue.push(wire)
    this.timer ??= setTimeout(() => {
      this.flush()
    }, this.batchMs)
  }

  /** Listener shape for `HarnessHost.rawTap`. */
  tap(): (sessionId: string, event: unknown) => void {
    return (sessionId, event) => this.push(sessionId, event)
  }

  /** Send every queued batch now. */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.size === 0) return
    const batches: SessionEventBatch[] = [...this.pending].map(
      ([sessionId, events]) => ({ sessionId, events }),
    )
    this.pending.clear()
    for (const target of [...this.targets]) {
      if (target.isDestroyed?.()) {
        this.targets.delete(target)
        continue
      }
      for (const batch of batches) target.send(SESSION_EVENT_CHANNEL, batch)
    }
  }

  /** Drop queued events and stop the timer. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
  }

  size(): number {
    return this.targets.size
  }
}
