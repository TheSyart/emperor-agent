/** Framed, validated main-process connection to a platform helper. */
import type { Duplex } from 'node:stream'
import {
  isUiErrorCode,
  UiError,
} from '../../../../packages/core/src/harness/computer-use/errors'
import {
  FrameDecoder,
  encodeJsonFrame,
} from '../../../../packages/core/src/harness/computer-use/protocol/framing'
import {
  acceptHello,
  HELPER_EVENTS,
  HELPER_METHODS,
  HELPER_PROTOCOL_VERSION,
  parseHelperMessage,
  type HelperEvent,
  type HelperHello,
  type HelperMethod,
  type HelperParams,
  type HelperResult,
} from '../../../../packages/core/src/harness/computer-use/protocol/messages'

type Platform = HelperHello['platform']
type Packet = { result: unknown; blobs: ReadonlyMap<string, Uint8Array> }

/** Recovery advice for the model, keyed by the static reasons below. */
const HELPER_REASON_HINTS: Readonly<Record<string, string>> = {
  'target-input-point-unverified':
    'Move the target window clear of overlays, observe again, and stop if the input point is still blocked.',
  'focused-text-editor-unavailable':
    "Pass the text field's ref from the latest observation (apps such as VS Code do not report their focused input), observe again, then retry the text input.",
  'target-window-not-focused':
    'Another window of this app, often a dialog, has focus. Observe it or ask the user to close it; no input was sent.',
  'frontmost-app-unverified':
    'The frontmost app could not be identified, so no input was sent. Observe again; if this repeats, ask the user to bring the target window forward.',
  'background-delivery-unconfirmed':
    'The keys may not have reached the app. Observe first; retry once only if the text is absent.',
  'foreground-required':
    'The app is in the background and this step needs the front, so nothing was sent. Prefer a background route (an element with a press action, desktop_fill, desktop_menu_select); otherwise call desktop_activate (in per-item mode the user is asked), then retry.',
  'background-keys-ignored':
    'This app ignores keys while it is in the background, so nothing was sent. Set text with desktop_fill and click elements that have a press action; otherwise call desktop_activate (in per-item mode the user is asked) and retry.',
  'menu-needs-front':
    "The app greys out this command while it is in the background, so nothing was sent. Look for a background route (a window's close button, an element with a press action); otherwise call desktop_activate (in per-item mode the user is asked), then run the command again right away.",
  'menu-item-not-found':
    'List the menu with desktop_menu and use the exact titles it returns.',
  'target-closed-after-dispatch':
    'The window (or its app) closed right after this action, which usually means the action did what it was meant to, such as closing or quitting. Confirm with desktop_list_windows; never repeat it.',
  'accessibility-permission-missing':
    'macOS Accessibility permission for Emperor Computer Helper is off, so nothing was done. There is no card to confirm in Emperor: ask the user to turn it on in System Settings › Privacy & Security › Accessibility (Settings › 电脑操作 has a button that opens it), and wait until they say it is on.',
  'screen-recording-permission-missing':
    'macOS Screen Recording permission for Emperor Computer Helper is off, so nothing was captured. There is no card to confirm in Emperor: ask the user to turn it on in System Settings › Privacy & Security › Screen & System Audio Recording (Settings › 电脑操作 has a button that opens it), and wait until they say it is on.',
  'menu-item-disabled':
    "The command is unavailable in the app's current state; observe the window before choosing another route.",
  'menu-path-is-menu':
    'That title opens a menu; list it with desktop_menu and choose a command inside.',
  'menu-path-is-command':
    'That path is a command; run it with desktop_menu_select.',
}

/** Exact, static helper messages only. Never forward arbitrary native text. */
function safeHelperFailureReason(
  code: string,
  message: string,
): string | undefined {
  if (code === 'TARGET_NOT_VISIBLE') {
    if (message === 'Bring target window to the foreground')
      return 'target-app-not-frontmost'
    if (message === 'Bring target window to the front')
      return 'target-window-not-focused'
    if (message === 'Finder input point could not be verified')
      return 'target-input-point-unverified'
    if (message === 'Focused element is not an editable text control')
      return 'focused-text-editor-unavailable'
    if (message === 'Frontmost application could not be verified')
      return 'frontmost-app-unverified'
    if (message === 'Target app is in the background')
      return 'foreground-required'
    if (message === 'Background keys are ignored by this app')
      return 'background-keys-ignored'
    if (message === 'Menu needs the app in front') return 'menu-needs-front'
  }
  if (code === 'INVALID_REQUEST') {
    if (message === 'Menu item not found') return 'menu-item-not-found'
    if (message === 'Menu item is disabled') return 'menu-item-disabled'
    if (message === 'Menu path names a menu, not a command')
      return 'menu-path-is-menu'
    if (message === 'Menu path names a command, not a menu')
      return 'menu-path-is-command'
  }
  if (code === 'PERMISSION_REQUIRED') {
    if (message === 'Accessibility permission is required')
      return 'accessibility-permission-missing'
    if (message === 'Screen recording permission is required')
      return 'screen-recording-permission-missing'
  }
  if (code === 'CAPABILITY_DISABLED') {
    if (message === 'App has no menu bar') return 'no-menu-bar'
    if (message === 'Menu item has no press action')
      return 'menu-item-not-pressable'
  }
  if (code === 'OUTCOME_UNKNOWN') {
    if (message === 'Target changed after dispatch')
      return 'post-dispatch-target-recheck-failed'
    if (message === 'Target window closed after dispatch')
      return 'target-closed-after-dispatch'
    if (message === 'Action dispatched but effect is unconfirmed')
      return 'post-dispatch-no-revision'
    if (message === 'Background key delivery unconfirmed')
      return 'background-delivery-unconfirmed'
  }
  return undefined
}

type Pending = {
  method: HelperMethod
  resolve(value: Packet): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
  result?: unknown
  blobs: Map<string, Uint8Array>
  missingBlobs: Set<string>
  sent: boolean
}

export interface HelperClientOptions {
  readonly platform: Platform
  /** Required by the macOS helper; never included in diagnostics. */
  readonly nonce?: string
  readonly handshakeMs?: number
  readonly heartbeatMs?: number
  readonly maxMissedPings?: number
}

export interface HelperDiagnostics {
  readonly connected: boolean
  readonly helperVersion: string | null
  readonly protocol: number | null
  readonly platform: Platform | null
  readonly arch: string | null
  readonly capabilities: readonly string[]
  readonly permissions: Readonly<
    Record<string, 'granted' | 'denied' | 'unknown' | 'stale'>
  >
  readonly pendingRequests: number
  readonly missedPings: number
  readonly lastErrorCode: string | null
}

export class HelperClient {
  readonly ready: Promise<HelperHello>
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly ignoredResponses = new Set<number>()
  private readonly ignoredBlobs = new Set<string>()
  private readonly listeners = new Set<(event: HelperEvent) => void>()
  private readonly disconnectedListeners = new Set<(error: UiError) => void>()
  private readonly options: Required<
    Pick<
      HelperClientOptions,
      'platform' | 'handshakeMs' | 'heartbeatMs' | 'maxMissedPings'
    >
  > &
    Pick<HelperClientOptions, 'nonce'>
  private resolveReady!: (hello: HelperHello) => void
  private rejectReady!: (error: Error) => void
  private handshakeTimer: ReturnType<typeof setTimeout>
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private hello: HelperHello | null = null
  private closed = false
  private nextId = 1
  private nextPing = 1
  private missedPings = 0
  private lastPingSeq = 0
  private lastAckSeq = 0
  private lastErrorCode: string | null = null
  private blobOwner: number | null = null

  constructor(
    private readonly stream: Duplex,
    options: HelperClientOptions,
  ) {
    this.options = {
      platform: options.platform,
      handshakeMs: options.handshakeMs ?? 5_000,
      heartbeatMs: options.heartbeatMs ?? 5_000,
      maxMissedPings: options.maxMissedPings ?? 3,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    }
    if (
      this.options.platform === 'macos' &&
      !/^[A-Za-z0-9_-]{16,128}$/.test(this.options.nonce ?? '')
    )
      throw new UiError(
        'INVALID_REQUEST',
        'macOS helper launch nonce is missing or invalid',
      )
    this.ready = new Promise<HelperHello>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // A caller may observe diagnostics without awaiting ready. Keep rejection handled.
    void this.ready.catch(() => undefined)
    stream.on('data', (chunk: Buffer) => this.onData(chunk))
    stream.on('error', () =>
      this.fail(new UiError('DRIVER_UNAVAILABLE', 'Helper connection failed')),
    )
    stream.on('close', () =>
      this.fail(
        new UiError(
          'DRIVER_UNAVAILABLE',
          // The macOS helper rejects an unverified peer by closing before it
          // greets; its reason goes only to the helper's stderr.
          this.hello === null
            ? 'Helper closed the connection before hello (peer rejected or helper exited)'
            : 'Helper disconnected',
        ),
      ),
    )
    this.handshakeTimer = setTimeout(
      () =>
        this.fail(
          new UiError('DRIVER_UNAVAILABLE', 'Helper handshake timed out'),
        ),
      this.options.handshakeMs,
    )
  }

  diagnostics(): HelperDiagnostics {
    return {
      connected: this.hello !== null && !this.closed,
      helperVersion: this.hello?.helperVersion ?? null,
      protocol: this.hello?.protocol ?? null,
      platform: this.hello?.platform ?? null,
      arch: this.hello?.arch ?? null,
      capabilities: this.hello?.capabilities ?? [],
      permissions: this.hello?.permissions ?? {},
      pendingRequests: this.pending.size,
      missedPings: this.missedPings,
      lastErrorCode: this.lastErrorCode,
    }
  }

  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDisconnected(listener: (error: UiError) => void): () => void {
    this.disconnectedListeners.add(listener)
    return () => this.disconnectedListeners.delete(listener)
  }

  async request<M extends HelperMethod>(
    method: M,
    params: HelperParams<M>,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<HelperResult<M>> {
    const packet = await this.requestWithBlobs(method, params, options)
    return packet.result
  }

  async requestWithBlobs<M extends HelperMethod>(
    method: M,
    params: HelperParams<M>,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    result: HelperResult<M>
    blobs: ReadonlyMap<string, Uint8Array>
  }> {
    await this.ready
    if (this.closed)
      throw new UiError('DRIVER_UNAVAILABLE', 'Helper disconnected')
    const spec = HELPER_METHODS[method]
    if (spec === undefined)
      throw new UiError('INVALID_REQUEST', 'Unknown helper method')
    const safeParams = spec.params.parse(params)
    const deadlineMs = options.deadlineMs ?? 30_000
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000)
      throw new UiError('INVALID_REQUEST', 'Invalid helper request deadline')
    if (options.signal?.aborted)
      throw new UiError('OUTCOME_UNKNOWN', 'Helper request cancelled')
    const id = this.nextId++
    if (!Number.isSafeInteger(id))
      throw new UiError('DRIVER_UNAVAILABLE', 'Helper request ID exhausted')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.cancel(
            id,
            new UiError('OUTCOME_UNKNOWN', 'Helper request timed out'),
          ),
        deadlineMs,
      )
      const entry: Pending = {
        method,
        resolve: (packet) =>
          resolve(
            packet as {
              result: HelperResult<M>
              blobs: ReadonlyMap<string, Uint8Array>
            },
          ),
        reject,
        timer,
        blobs: new Map(),
        missingBlobs: new Set(),
        sent: false,
      }
      if (options.signal) {
        const onAbort = () =>
          this.cancel(
            id,
            new UiError('OUTCOME_UNKNOWN', 'Helper request cancelled'),
          )
        options.signal.addEventListener('abort', onAbort, { once: true })
        entry.removeAbort = () =>
          options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, entry)
      try {
        this.send({
          type: 'request',
          id,
          method,
          params: safeParams,
          deadlineMs,
        })
        entry.sent = true
      } catch {
        this.settle(
          id,
          new UiError('DRIVER_UNAVAILABLE', 'Could not send helper request'),
        )
      }
    })
  }

  /**
   * Best-effort input cleanup. The native helper also releases input on peer
   * EOF. `recovery` (after a crashed helper was replaced) also releases keys
   * and buttons the session still reports as held (00 §12).
   */
  async releaseAll(options: { recovery?: boolean } = {}): Promise<void> {
    if (this.closed || this.hello === null) return
    try {
      await this.request(
        'input.releaseAll',
        options.recovery === true ? { recovery: true } : {},
        { deadlineMs: 1_000 },
      )
    } catch {
      // The helper may already be gone; input is released on its disconnect path.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.releaseAll()
    if (!this.closed && this.hello !== null) {
      try {
        await this.request('shutdown', {}, { deadlineMs: 1_000 })
      } catch {
        // A closed connection has the same native cleanup contract.
      }
    }
    this.fail(new UiError('DRIVER_UNAVAILABLE', 'Helper connection closed'))
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === 'blob') {
          this.onBlob(frame.blobId, frame.bytes)
          continue
        }
        if (this.blobOwner !== null)
          throw new Error('JSON message interrupted screenshot blobs')
        const message = parseHelperMessage(frame.value)
        if (this.hello === null) {
          if (message.type !== 'hello') throw new Error('Expected helper hello')
          const hello = acceptHello(message)
          if (hello.platform !== this.options.platform)
            throw new Error('Unexpected helper platform')
          this.send({
            type: 'welcome',
            protocol: HELPER_PROTOCOL_VERSION,
            ...(this.options.nonce ? { nonce: this.options.nonce } : {}),
          })
          this.hello = hello
          clearTimeout(this.handshakeTimer)
          this.resolveReady(hello)
          this.heartbeatTimer = setInterval(
            () => this.ping(),
            this.options.heartbeatMs,
          )
          continue
        }
        switch (message.type) {
          case 'response':
            this.onResponse(message)
            break
          case 'event': {
            const schema =
              HELPER_EVENTS[message.name as keyof typeof HELPER_EVENTS]
            if (!schema) throw new Error('Unknown helper event')
            const data = schema.parse(message.data)
            if (message.name === 'permissions.changed' && this.hello)
              this.hello = {
                ...this.hello,
                permissions: (
                  data as { permissions: HelperHello['permissions'] }
                ).permissions,
              }
            for (const listener of this.listeners) {
              try {
                listener(message)
              } catch {
                /* Client listeners cannot corrupt transport. */
              }
            }
            break
          }
          case 'ping':
            this.send({ type: 'pong', seq: message.seq })
            break
          case 'pong':
            if (
              message.seq > this.lastAckSeq &&
              message.seq <= this.lastPingSeq
            ) {
              this.lastAckSeq = message.seq
              this.missedPings = 0
            }
            break
          default:
            throw new Error('Unexpected helper message')
        }
      }
    } catch (error) {
      this.fail(
        error instanceof UiError
          ? error
          : new UiError('DRIVER_UNAVAILABLE', 'Invalid helper protocol frame'),
      )
    }
  }

  private onResponse(
    message: Extract<
      ReturnType<typeof parseHelperMessage>,
      { type: 'response' }
    >,
  ): void {
    const entry = this.pending.get(message.id)
    if (!entry) {
      if (this.ignoredResponses.delete(message.id)) return
      throw new Error('Unknown helper response ID')
    }
    if (!message.ok) {
      // Native errors are never saved to diagnostics, as a buggy helper could echo a secret.
      if (!isUiErrorCode(message.error.code))
        throw new Error('Unknown helper error code')
      this.lastErrorCode = message.error.code
      const reason = safeHelperFailureReason(
        message.error.code,
        message.error.message,
      )
      const hint =
        reason === undefined ? undefined : HELPER_REASON_HINTS[reason]
      const options =
        reason === undefined
          ? undefined
          : { reason, ...(hint === undefined ? {} : { hint }) }
      this.settle(
        message.id,
        new UiError(message.error.code, 'Helper request failed', options),
      )
      return
    }
    if (entry.result !== undefined) throw new Error('Duplicate helper response')
    const result = HELPER_METHODS[entry.method].result.parse(message.result)
    entry.result = result
    if (entry.method === 'observe.screenshot') {
      const screenshot = result as HelperResult<'observe.screenshot'>
      entry.missingBlobs.add(screenshot.blobId)
      if (screenshot.model) entry.missingBlobs.add(screenshot.model.blobId)
      this.blobOwner = message.id
      return
    }
    if (entry.method === 'target.preview') {
      const preview = result as HelperResult<'target.preview'>
      if (preview.blobId !== undefined) {
        entry.missingBlobs.add(preview.blobId)
        this.blobOwner = message.id
        return
      }
    }
    this.settle(message.id)
  }

  private onBlob(blobId: string, bytes: Uint8Array): void {
    const id = this.blobOwner
    const entry = id === null ? undefined : this.pending.get(id)
    if (!entry && this.ignoredBlobs.delete(blobId)) return
    if (!entry || !entry.missingBlobs.delete(blobId))
      throw new Error('Unexpected helper blob')
    entry.blobs.set(blobId, bytes)
    if (entry.missingBlobs.size === 0) {
      this.blobOwner = null
      this.settle(id!)
    }
  }

  private settle(id: number, error?: Error): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.removeAbort?.()
    if (this.blobOwner === id) this.blobOwner = null
    if (error) entry.reject(error)
    else entry.resolve({ result: entry.result, blobs: entry.blobs })
  }

  private cancel(id: number, error: UiError): void {
    const entry = this.pending.get(id)
    if (!entry) return
    if (entry.sent && !this.closed) {
      try {
        this.send({ type: 'cancel', id })
      } catch {
        /* EOF follows. */
      }
      this.ignoredResponses.add(id)
      if (this.ignoredResponses.size > 1_024)
        this.ignoredResponses.delete(
          this.ignoredResponses.values().next().value!,
        )
      for (const blobId of entry.missingBlobs) this.ignoredBlobs.add(blobId)
      if (this.ignoredBlobs.size > 1_024)
        this.ignoredBlobs.delete(this.ignoredBlobs.values().next().value!)
    }
    this.settle(id, error)
    if (entry.method !== 'input.releaseAll') void this.releaseAll()
  }

  private ping(): void {
    if (this.closed) return
    if (this.missedPings >= this.options.maxMissedPings) {
      this.fail(new UiError('DRIVER_UNAVAILABLE', 'Helper heartbeat lost'))
      return
    }
    this.missedPings++
    this.lastPingSeq = this.nextPing++
    try {
      this.send({ type: 'ping', seq: this.lastPingSeq })
    } catch {
      this.fail(new UiError('DRIVER_UNAVAILABLE', 'Helper heartbeat failed'))
    }
  }

  private send(message: unknown): void {
    if (this.closed || this.stream.destroyed)
      throw new Error('Helper stream closed')
    this.stream.write(Buffer.from(encodeJsonFrame(message)))
  }

  private fail(error: UiError): void {
    if (this.closed) return
    // When the connection still accepts writes, ask for input cleanup before EOF.
    // Swift also releases input when the peer disappears without this frame.
    if (this.hello !== null && !this.stream.destroyed && this.stream.writable) {
      try {
        this.send({
          type: 'request',
          id: this.nextId++,
          method: 'input.releaseAll',
          params: {},
          deadlineMs: 1_000,
        })
      } catch {
        /* A failed write is covered by the helper's EOF cleanup. */
      }
    }
    this.closed = true
    this.lastErrorCode = error.code
    clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.rejectReady(error)
    for (const [id, entry] of this.pending) {
      this.settle(
        id,
        entry.sent
          ? new UiError('OUTCOME_UNKNOWN', 'Helper disconnected during request')
          : error,
      )
    }
    this.stream.destroy()
    for (const listener of this.disconnectedListeners) {
      try {
        listener(error)
      } catch {
        /* Observer errors do not alter shutdown. */
      }
    }
  }
}
