import type { TerminalEvent } from '@emperor/core'
import { TERMINAL_EVENT_CHANNEL } from '../shared/ipc-contract'
import type { WebContentsLike } from './event-bridge'

export class TerminalEventBridge {
  private target: WebContentsLike | null = null
  private subscription: { sessionId: string; terminalId: string } | null = null
  private readonly pending = new Map<
    string,
    Array<Extract<TerminalEvent, { type: 'output' }>>
  >()
  private readonly pendingBytes = new Map<string, number>()
  private flushTimer: NodeJS.Timeout | null = null
  private readonly maxBatchBytes = 256 * 1024

  attach(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) {
      this.target = webContents
      this.subscription = null
      this.clearPending()
    }
  }

  detach(webContents: WebContentsLike): void {
    if (this.target === webContents) {
      this.target = null
      this.subscription = null
      this.clearPending()
    }
  }

  emit(event: TerminalEvent): void {
    if (this.target?.isDestroyed?.()) {
      this.target = null
      this.subscription = null
      this.clearPending()
      return
    }
    if (!this.target || !this.subscription) return
    if (event.sessionId !== this.subscription.sessionId) return
    if (event.type === 'exit') {
      this.flush(event.sessionId, event.terminalId)
      this.target.send(TERMINAL_EVENT_CHANNEL, event)
      return
    }
    if (event.terminalId !== this.subscription.terminalId) return
    const key = `${event.sessionId}\0${event.terminalId}`
    const eventBytes = Buffer.byteLength(event.data)
    if ((this.pendingBytes.get(key) ?? 0) + eventBytes > this.maxBatchBytes)
      this.flush(event.sessionId, event.terminalId)
    const current = this.pending.get(key) ?? []
    current.push(event)
    this.pending.set(key, current)
    this.pendingBytes.set(key, (this.pendingBytes.get(key) ?? 0) + eventBytes)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 16)
  }

  setSubscription(
    webContents: WebContentsLike,
    subscription: { sessionId: string; terminalId: string } | null,
  ): void {
    if (this.target !== webContents || webContents.isDestroyed?.()) return
    this.subscription = subscription
    this.clearPending()
  }

  flush(sessionId?: string, terminalId?: string): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.target || !this.subscription) {
      this.pending.clear()
      this.pendingBytes.clear()
      return
    }
    for (const [key, events] of [...this.pending]) {
      const event = events[0]
      if (!event) continue
      if (
        sessionId !== undefined &&
        (event.sessionId !== sessionId || event.terminalId !== terminalId)
      )
        continue
      this.pending.delete(key)
      this.pendingBytes.delete(key)
      this.target.send(TERMINAL_EVENT_CHANNEL, events)
    }
    if (this.pending.size) this.flushTimer = setTimeout(() => this.flush(), 16)
  }

  sink(): (event: TerminalEvent) => void {
    return (event) => this.emit(event)
  }

  private clearPending(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.pending.clear()
    this.pendingBytes.clear()
  }
}
