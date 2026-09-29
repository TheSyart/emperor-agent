/**
 * One Chrome DevTools Protocol connection per Agent tab, over Electron's
 * `webContents.debugger` (spec 00 §7.3). Commands carry a deadline and an
 * abort signal; a detach (DevTools took over, the tab closed) fails every
 * pending command with `DRIVER_UNAVAILABLE` and is reported once.
 *
 * Only the driver talks to this object; nothing here is reachable from a
 * model, a page or the renderer.
 */

import { UiError } from '@emperor/core/host-capabilities'

export interface DebuggerLike {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<unknown>
  on(
    event: 'message',
    listener: (
      event: unknown,
      method: string,
      params: unknown,
      sessionId: string,
    ) => void,
  ): unknown
  on(
    event: 'detach',
    listener: (event: unknown, reason: string) => void,
  ): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

export type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
) => void

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

export class CdpSession {
  private detached: string | null = null
  private readonly listeners = new Set<CdpEventListener>()
  private readonly pending = new Set<(error: Error) => void>()
  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string,
  ): void => {
    const record =
      typeof params === 'object' && params !== null
        ? (params as Record<string, unknown>)
        : {}
    for (const listener of this.listeners) {
      try {
        listener(method, record, sessionId)
      } catch {
        // a broken listener must not break the connection
      }
    }
  }
  private readonly onDetach = (_event: unknown, reason: string): void => {
    this.markDetached(reason)
  }

  constructor(
    private readonly debuggerApi: DebuggerLike,
    private readonly onDetached: (reason: string) => void = () => undefined,
  ) {}

  /** Attach, or throw `DRIVER_UNAVAILABLE` (e.g. DevTools already owns it). */
  attach(): void {
    try {
      if (!this.debuggerApi.isAttached()) this.debuggerApi.attach('1.3')
    } catch (error) {
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'the page debugger is in use (is DevTools open?)',
        {
          cause: error,
        },
      )
    }
    this.detached = null
    this.debuggerApi.on('message', this.onMessage)
    this.debuggerApi.on('detach', this.onDetach)
  }

  get attached(): boolean {
    return this.detached === null && this.debuggerApi.isAttached()
  }

  get detachReason(): string | null {
    return this.detached
  }

  subscribe(listener: CdpEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    options: {
      sessionId?: string
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    if (this.detached !== null)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        `debugger detached: ${this.detached}`,
      )
    if (options.signal?.aborted)
      throw new UiError('TIMEOUT_NO_EFFECT', 'aborted')
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(fail)
        action()
      }
      const fail = (error: Error): void => finish(() => reject(error))
      const onAbort = (): void =>
        fail(new UiError('TIMEOUT_NO_EFFECT', `${method} aborted`))
      const timer = setTimeout(
        () =>
          fail(
            new UiError(
              'TIMEOUT_NO_EFFECT',
              `${method} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      )
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.add(fail)
      this.debuggerApi.sendCommand(method, params, options.sessionId).then(
        (value) => finish(() => resolve(value as T)),
        (error: unknown) =>
          fail(
            this.detached !== null
              ? new UiError(
                  'DRIVER_UNAVAILABLE',
                  `debugger detached: ${this.detached}`,
                )
              : new UiError(
                  'DRIVER_UNAVAILABLE',
                  `${method} failed: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error, reason: 'cdp-error' },
                ),
          ),
      )
    })
  }

  detach(): void {
    this.debuggerApi.removeListener('message', this.onMessage as never)
    this.debuggerApi.removeListener('detach', this.onDetach as never)
    try {
      if (this.debuggerApi.isAttached()) this.debuggerApi.detach()
    } catch {
      // already gone
    }
    this.markDetached('closed', false)
  }

  private markDetached(reason: string, notify = true): void {
    if (this.detached !== null) return
    this.detached = reason
    for (const fail of [...this.pending])
      fail(new UiError('DRIVER_UNAVAILABLE', `debugger detached: ${reason}`))
    if (notify) this.onDetached(reason)
  }
}
