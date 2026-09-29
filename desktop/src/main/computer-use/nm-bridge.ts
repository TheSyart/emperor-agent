/** macOS Chrome/Edge Native Messaging socket and end-to-end pairing bridge. */
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import {
  authProof,
  createPair,
  createTraffic,
  matchingToken,
  open,
  pairProof,
  parseToken,
  seal,
  token,
  type PairOffer,
  type PendingPair,
  type Traffic,
} from './nm-bridge-crypto'
import type {
  BrowserPairing,
  PairingStore,
  PairingSummary,
} from './nm-bridge-store'
import {
  EMPEROR_EXTENSION_ID,
  NM_BROWSER_KEYS,
  type NmBrowser,
  type NmManifestChange,
} from './nm-manifest'
import { isExactHttpOrigin } from './web-origin'

const BROWSER_TO_MAIN_MAX = 64 * 1024 * 1024
const MAIN_TO_BROWSER_MAX = 1024 * 1024
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function codeError(code: string): Error {
  const error = new Error(code)
  error.name = code
  return error
}

export function defaultNmSocketPath(): string {
  if (process.platform !== 'darwin' || process.getuid === undefined)
    throw new Error('Native Messaging socket is macOS-only')
  return join(
    userInfo().homedir,
    '.emperor',
    'run',
    `nm-${process.getuid()}.sock`,
  )
}

export interface PairingApproval {
  readonly pairingId: string
  readonly extensionId: string
  readonly code: string
  readonly displayed: boolean
}

export type NmBridgeEvent =
  | { readonly type: 'pairing'; readonly request: PairingApproval }
  | {
      readonly type: 'paired'
      readonly pairingId: string
      readonly extensionId: string
    }
  | {
      readonly type: 'ready'
      readonly pairingId: string
      readonly extensionId: string
      readonly workerEpoch: number
    }
  | {
      readonly type: 'target-attached'
      readonly pairingId: string
      readonly targetId: string
      readonly tabId: number
      readonly windowId: number
      readonly origin: string
      readonly generation: number
    }
  | {
      readonly type: 'target-lost'
      readonly pairingId: string
      readonly targetId: string
      readonly generation: number
      readonly reason: string
    }
  | { readonly type: 'disconnected'; readonly pairingId: string }
  | { readonly type: 'revoked'; readonly pairingId: string }

/** Host manifest upkeep (01 §11), implemented by `NmManifestRegistrar`. */
export interface NmHostManifests {
  reconcile(
    pairedExtensionIds: readonly string[],
  ): Promise<readonly NmManifestChange[]>
  register(
    extensionId: string,
    pairedExtensionIds: readonly string[],
    browsers?: readonly NmBrowser[],
  ): Promise<readonly NmManifestChange[]>
  unregister(
    extensionId: string,
    remainingExtensionIds: readonly string[],
  ): Promise<readonly NmManifestChange[]>
}

export interface NmBridgeOptions {
  readonly pairings: PairingStore
  readonly socketPath?: string
  /**
   * Keeps Chrome/Edge manifests in step with pairings: repoint on start,
   * admit an approved extension, remove with the last Emperor-side revoke.
   * Omit it (tests, packaged smoke) to never touch browser directories.
   */
  readonly manifests?: NmHostManifests
  /** 0 disables heartbeat for deterministic tests. Production default: 5 s. */
  readonly heartbeatMs?: number
  /** Delay before retrying a socket held by another Emperor. 0 disables retry. */
  readonly retryMs?: number
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

class NmConnection {
  private buffer = Buffer.alloc(0)
  private queue: Promise<void> = Promise.resolve()
  private pendingPair:
    (PendingPair & { displayed: boolean; approved: boolean }) | null = null
  private pendingAuth: {
    pairing: BrowserPairing
    extensionNonce: string
    mainNonce: string
  } | null = null
  private traffic: Traffic | null = null
  private pairing: BrowserPairing | null = null
  private ready = false
  private nextRequestId = 0
  private readonly responses = new Map<number, PendingResponse>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pingSequence = 0
  private missedPongs = 0
  private closed = false

  constructor(
    private readonly bridge: NmBridgeServer,
    private readonly socket: Socket,
  ) {
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.receiveBytes(chunk))
    socket.on('close', () => this.close())
    socket.on('error', () => socket.destroy())
  }

  get pairingId(): string | null {
    return this.pairing?.pairingId ?? null
  }
  get isReady(): boolean {
    return this.ready && !this.closed
  }
  get approval(): PairingApproval | null {
    const pending = this.pendingPair
    return pending === null || pending.approved
      ? null
      : {
          pairingId: pending.pairingId,
          extensionId: pending.extensionId,
          code: pending.code,
          displayed: pending.displayed,
        }
  }
  hasPairing(pairingId: string): boolean {
    return (
      this.pairing?.pairingId === pairingId ||
      this.pendingAuth?.pairing.pairingId === pairingId ||
      this.pendingPair?.pairingId === pairingId
    )
  }

  private receiveBytes(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = LITTLE_ENDIAN
        ? this.buffer.readUInt32LE(0)
        : this.buffer.readUInt32BE(0)
      if (length === 0 || length > BROWSER_TO_MAIN_MAX) {
        this.socket.destroy()
        return
      }
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      this.queue = this.queue
        .then(() => this.receiveFrame(body))
        .catch(() => {
          this.socket.destroy()
        })
    }
  }

  private sendRaw(message: unknown): void {
    if (this.closed || this.socket.destroyed)
      throw codeError('DRIVER_UNAVAILABLE')
    const body = Buffer.from(JSON.stringify(message))
    if (body.length > MAIN_TO_BROWSER_MAX) throw codeError('FRAME_TOO_LARGE')
    const prefix = Buffer.allocUnsafe(4)
    if (LITTLE_ENDIAN) prefix.writeUInt32LE(body.length)
    else prefix.writeUInt32BE(body.length)
    this.socket.write(Buffer.concat([prefix, body]))
  }

  private sendSecure(message: unknown): void {
    if (!this.traffic || !this.pairing) throw codeError('DRIVER_UNAVAILABLE')
    this.sendRaw(seal(this.traffic, this.pairing.pairingId, message))
  }

  private reply(id: number, result: unknown): void {
    this.sendRaw({ type: 'response', id, ok: true, result })
  }

  private refuse(id: number, code: string): void {
    this.sendRaw({
      type: 'response',
      id,
      ok: false,
      error: { code, message: code, retryable: false },
    })
  }

  private async receiveFrame(body: Buffer): Promise<void> {
    if (this.closed) return
    if (this.pairing && this.bridge.isRevoked(this.pairing.pairingId))
      throw codeError('PERMISSION_DENIED')
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (!isRecord(parsed)) throw codeError('PROTOCOL_MISMATCH')
    if (parsed.type === 'secure') {
      if (!this.traffic || !this.pairing) throw codeError('PERMISSION_DENIED')
      await this.receiveSecure(
        open(this.traffic, this.pairing.pairingId, parsed),
      )
      return
    }
    if (this.traffic) throw codeError('PERMISSION_DENIED')
    if (
      parsed.type === 'request' &&
      integer(parsed.id) &&
      typeof parsed.method === 'string' &&
      isRecord(parsed.params)
    ) {
      try {
        await this.rawRequest(parsed.id, parsed.method, parsed.params)
      } catch {
        this.refuse(parsed.id, 'PERMISSION_DENIED')
      }
      return
    }
    if (
      parsed.type === 'event' &&
      typeof parsed.name === 'string' &&
      isRecord(parsed.data)
    ) {
      await this.rawEvent(parsed.name, parsed.data)
      return
    }
    throw codeError('PROTOCOL_MISMATCH')
  }

  private async rawRequest(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'pair.begin') {
      if (this.pendingPair || this.pendingAuth || this.pairing)
        throw codeError('PERMISSION_DENIED')
      const pair = createPair(params as unknown as PairOffer)
      this.pendingPair = { ...pair, displayed: false, approved: false }
      this.reply(id, {
        pairingId: pair.pairingId,
        publicKey: pair.publicKey,
        nonce: pair.nonce,
      })
      this.bridge.notify({ type: 'pairing', request: this.approval! })
      return
    }
    if (method === 'auth.begin') {
      if (
        this.pendingAuth ||
        this.pendingPair ||
        this.pairing ||
        params.protocol !== 1 ||
        typeof params.pairingId !== 'string'
      )
        throw codeError('PERMISSION_DENIED')
      if (this.bridge.isRevoked(params.pairingId))
        throw codeError('PERMISSION_DENIED')
      parseToken(params.nonce, 16)
      const pairing = await this.bridge.pairings.get(params.pairingId)
      if (!pairing || this.bridge.isRevoked(params.pairingId) || this.closed)
        throw codeError('PERMISSION_DENIED')
      const extensionNonce = params.nonce as string
      const mainNonce = token(randomBytes(16))
      this.pendingAuth = { pairing, extensionNonce, mainNonce }
      this.reply(id, {
        nonce: mainNonce,
        proof: authProof(pairing.secret, extensionNonce, mainNonce, 'main'),
      })
      return
    }
    if (method === 'auth.finish') {
      const auth = this.pendingAuth
      if (
        !auth ||
        this.bridge.isRevoked(auth.pairing.pairingId) ||
        params.pairingId !== auth.pairing.pairingId ||
        !matchingToken(
          authProof(
            auth.pairing.secret,
            auth.extensionNonce,
            auth.mainNonce,
            'extension',
          ),
          params.proof,
        )
      )
        throw codeError('PERMISSION_DENIED')
      this.traffic = createTraffic(
        auth.pairing.secret,
        auth.extensionNonce,
        auth.mainNonce,
      )
      this.pairing = auth.pairing
      this.pendingAuth = null
      this.reply(id, { accepted: true })
      return
    }
    throw codeError('CAPABILITY_DISABLED')
  }

  private async rawEvent(
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (name === 'pair.displayed') {
      if (!this.pendingPair || data.pairingId !== this.pendingPair.pairingId)
        throw codeError('PERMISSION_DENIED')
      this.pendingPair.displayed = true
      this.bridge.notify({ type: 'pairing', request: this.approval! })
      return
    }
    if (name === 'pair.ready') {
      const pending = this.pendingPair
      if (
        !pending ||
        !pending.approved ||
        data.pairingId !== pending.pairingId ||
        !matchingToken(
          pairProof(pending.secret, pending.transcript, 'extension-ready'),
          data.proof,
        )
      )
        throw codeError('PERMISSION_DENIED')
      this.pendingPair = null
      this.bridge.notify({
        type: 'paired',
        pairingId: pending.pairingId,
        extensionId: pending.extensionId,
      })
      return
    }
    throw codeError('PROTOCOL_MISMATCH')
  }

  async approve(pairingId: string): Promise<boolean> {
    const pending = this.pendingPair
    if (
      !pending ||
      pending.pairingId !== pairingId ||
      !pending.displayed ||
      pending.approved ||
      this.closed
    )
      return false
    pending.approved = true
    try {
      await this.bridge.pairings.put({
        pairingId,
        extensionId: pending.extensionId,
        secret: pending.secret,
        createdAt: new Date().toISOString(),
      })
    } catch (cause) {
      pending.approved = false
      throw cause
    }
    if (
      this.closed ||
      this.pendingPair !== pending ||
      this.bridge.isRevoked(pairingId)
    ) {
      await this.bridge.pairings.remove(pairingId)
      return false
    }
    this.sendRaw({
      type: 'event',
      name: 'pair.approved',
      data: {
        pairingId,
        proof: pairProof(pending.secret, pending.transcript, 'main-approved'),
      },
    })
    await this.bridge.pairingApproved(pending.extensionId)
    return true
  }

  deny(pairingId: string): boolean {
    if (
      !this.pendingPair ||
      this.pendingPair.pairingId !== pairingId ||
      this.pendingPair.approved ||
      this.closed
    )
      return false
    this.pendingPair = null
    this.sendRaw({ type: 'event', name: 'pair.rejected', data: {} })
    return true
  }

  private async receiveSecure(frame: unknown): Promise<void> {
    if (!isRecord(frame)) throw codeError('PROTOCOL_MISMATCH')
    if (
      frame.type === 'event' &&
      typeof frame.name === 'string' &&
      isRecord(frame.data)
    ) {
      const data = frame.data
      if (frame.name === 'bridge.ready') {
        const pairing = this.pairing
        if (
          this.ready ||
          !pairing ||
          data.protocol !== 1 ||
          data.extensionId !== pairing.extensionId ||
          !integer(data.workerEpoch)
        )
          throw codeError('PROTOCOL_MISMATCH')
        this.ready = true
        this.bridge.connectionReady(this)
        this.bridge.notify({
          type: 'ready',
          pairingId: pairing.pairingId,
          extensionId: pairing.extensionId,
          workerEpoch: data.workerEpoch,
        })
        this.startHeartbeat()
        return
      }
      if (!this.ready) throw codeError('PERMISSION_DENIED')
      if (frame.name === 'target.attached') {
        if (
          typeof data.targetId !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(data.targetId) ||
          !integer(data.tabId) ||
          !integer(data.windowId) ||
          !integer(data.generation) ||
          data.generation < 1 ||
          !isExactHttpOrigin(data.origin)
        )
          throw codeError('PROTOCOL_MISMATCH')
        this.bridge.notify({
          type: 'target-attached',
          pairingId: this.pairing!.pairingId,
          targetId: data.targetId,
          tabId: data.tabId,
          windowId: data.windowId,
          origin: data.origin,
          generation: data.generation,
        })
        return
      }
      if (frame.name === 'target.lost') {
        if (
          typeof data.targetId !== 'string' ||
          !integer(data.generation) ||
          typeof data.reason !== 'string'
        )
          throw codeError('PROTOCOL_MISMATCH')
        this.bridge.notify({
          type: 'target-lost',
          pairingId: this.pairing!.pairingId,
          targetId: data.targetId,
          generation: data.generation,
          reason: data.reason.slice(0, 100),
        })
        return
      }
      if (frame.name === 'pair.revoked') {
        if (data.pairingId !== this.pairing?.pairingId)
          throw codeError('PERMISSION_DENIED')
        await this.bridge.revokeFromExtension(this.pairing!.pairingId)
        this.bridge.notify({
          type: 'revoked',
          pairingId: this.pairing!.pairingId,
        })
        this.socket.destroy()
        return
      }
      throw codeError('CAPABILITY_DISABLED')
    }
    if (
      frame.type === 'response' &&
      integer(frame.id) &&
      typeof frame.ok === 'boolean'
    ) {
      const pending = this.responses.get(frame.id)
      if (!pending) return
      this.responses.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else
        pending.reject(
          codeError(
            isRecord(frame.error) && typeof frame.error.code === 'string'
              ? frame.error.code
              : 'DRIVER_UNAVAILABLE',
          ),
        )
      return
    }
    if (frame.type === 'pong' && integer(frame.seq)) {
      if (frame.seq === this.pingSequence) this.missedPongs = 0
      return
    }
    throw codeError('PROTOCOL_MISMATCH')
  }

  private startHeartbeat(): void {
    const period = this.bridge.heartbeatMs
    if (period <= 0) return
    this.heartbeat = setInterval(() => {
      if (!this.ready || this.closed) return
      if (++this.missedPongs >= 3) {
        this.socket.destroy()
        return
      }
      try {
        this.sendSecure({ type: 'ping', seq: ++this.pingSequence })
      } catch {
        this.socket.destroy()
      }
    }, period)
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.isReady) return Promise.reject(codeError('DRIVER_UNAVAILABLE'))
    if (
      ![
        'tabs.discover',
        'target.list',
        'target.observe',
        'target.act',
        'target.detach',
      ].includes(method)
    )
      return Promise.reject(codeError('CAPABILITY_DISABLED'))
    if (signal?.aborted) return Promise.reject(codeError('CANCELLED'))
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (cause?: Error, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.responses.delete(id)
        signal?.removeEventListener('abort', abort)
        if (cause) reject(cause)
        else resolve(result)
      }
      const timer = setTimeout(
        () => {
          finish(
            codeError(
              method === 'target.act'
                ? 'OUTCOME_UNKNOWN'
                : 'DRIVER_UNAVAILABLE',
            ),
          )
        },
        Math.min(Math.max(timeoutMs, 1), 120_000),
      )
      const abort = () => {
        finish(
          codeError(method === 'target.act' ? 'OUTCOME_UNKNOWN' : 'CANCELLED'),
        )
      }
      this.responses.set(id, {
        timer,
        resolve: (value) => finish(undefined, value),
        reject: (cause) => finish(cause),
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.sendSecure({
          type: 'request',
          id,
          method,
          params,
          deadlineMs: Math.min(Math.max(timeoutMs, 1), 120_000),
        })
      } catch (cause) {
        finish(cause as Error)
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.traffic?.inboundKey.fill(0)
    this.traffic?.outboundKey.fill(0)
    this.pendingPair = null
    this.pendingAuth = null
    for (const pending of this.responses.values()) {
      clearTimeout(pending.timer)
      pending.reject(codeError('DRIVER_UNAVAILABLE'))
    }
    this.responses.clear()
    this.bridge.connectionClosed(this)
  }

  destroy(): void {
    this.close()
    this.socket.destroy()
  }
}

export class NmBridgeServer {
  readonly socketPath: string
  readonly heartbeatMs: number
  readonly retryMs: number
  readonly pairings: PairingStore
  private readonly manifests: NmHostManifests | null
  private server: Server | null = null
  private readonly connections = new Set<NmConnection>()
  private readonly listeners = new Set<(event: NmBridgeEvent) => void>()
  private readonly revokedPairings = new Set<string>()
  private socketInode: number | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private startAttempt: Promise<boolean> | null = null
  private stopping = false
  private readonly ownedOperations = new Set<Promise<unknown>>()

  constructor(options: NmBridgeOptions) {
    this.socketPath = options.socketPath ?? defaultNmSocketPath()
    this.pairings = options.pairings
    this.manifests = options.manifests ?? null
    this.heartbeatMs = options.heartbeatMs ?? 5_000
    this.retryMs = options.retryMs ?? 5_000
  }

  subscribe(listener: (event: NmBridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(event: NmBridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* UI callbacks must not alter transport */
      }
    }
  }

  pendingPairings(): PairingApproval[] {
    return [...this.connections]
      .map((connection) => connection.approval)
      .filter((item): item is PairingApproval => item !== null)
  }

  async approvePairing(pairingId: string): Promise<boolean> {
    if (!this.server || this.stopping) return false
    for (const connection of this.connections) {
      if (connection.approval?.pairingId === pairingId)
        return this.trackOwnedOperation(connection.approve(pairingId))
    }
    return false
  }

  denyPairing(pairingId: string): boolean {
    if (!this.server || this.stopping) return false
    for (const connection of this.connections) {
      if (connection.approval?.pairingId === pairingId)
        return connection.deny(pairingId)
    }
    return false
  }

  readyPairings(): string[] {
    return [...this.connections]
      .filter((connection) => connection.isReady && connection.pairingId)
      .map((connection) => connection.pairingId!)
  }

  isRevoked(pairingId: string): boolean {
    return this.revokedPairings.has(pairingId)
  }

  /** A new authenticated worker session supersedes an older one for the same pairing. */
  connectionReady(connection: NmConnection): void {
    for (const previous of this.connections) {
      if (
        previous !== connection &&
        previous.pairingId === connection.pairingId &&
        previous.isReady
      )
        previous.destroy()
    }
  }

  /**
   * Emperor-side revoke (Settings). An extension-initiated `pair.revoked`
   * keeps the manifest so that extension can pair again.
   */
  async revokePairing(pairingId: string): Promise<void> {
    if (!this.server || this.stopping) throw codeError('DRIVER_UNAVAILABLE')
    return this.trackOwnedOperation(this.revokeOwnedPairing(pairingId))
  }

  private async revokeOwnedPairing(pairingId: string): Promise<void> {
    this.revokedPairings.add(pairingId)
    const revoked = this.manifests
      ? await this.pairings.list().then(
          (items) => items.find((item) => item.pairingId === pairingId),
          () => undefined,
        )
      : undefined
    await this.pairings.remove(pairingId)
    for (const connection of this.connections)
      if (connection.hasPairing(pairingId)) connection.destroy()
    this.notify({ type: 'revoked', pairingId })
    if (revoked)
      await this.maintainManifests((manifests, remaining) =>
        manifests.unregister(
          revoked.extensionId,
          remaining.map((item) => item.extensionId),
        ),
      )
  }

  async revokeFromExtension(pairingId: string): Promise<void> {
    if (!this.server || this.stopping) throw codeError('DRIVER_UNAVAILABLE')
    return this.trackOwnedOperation(this.pairings.remove(pairingId))
  }

  private trackOwnedOperation<T>(operation: Promise<T>): Promise<T> {
    this.ownedOperations.add(operation)
    void operation.then(
      () => this.ownedOperations.delete(operation),
      () => this.ownedOperations.delete(operation),
    )
    return operation
  }

  /**
   * Settings › 连接 Chrome/Edge (01 §11): register the host for the Emperor
   * extension in every browser that has run on this Mac, so the extension
   * can start pairing. Returns the browsers now able to reach Emperor.
   */
  async connectBrowsers(): Promise<{
    browsers: NmBrowser[]
    reason?: 'no-host' | 'unavailable'
  }> {
    const manifests = this.manifests
    if (!manifests || !this.server || this.stopping)
      return { browsers: [], reason: 'unavailable' }
    return this.trackOwnedOperation(this.registerOwnedBrowsers(manifests))
  }

  private async registerOwnedBrowsers(manifests: NmHostManifests): Promise<{
    browsers: NmBrowser[]
    reason?: 'no-host' | 'unavailable'
  }> {
    const paired = await this.pairings.list().catch(() => [])
    const changes = await manifests.register(
      EMPEROR_EXTENSION_ID,
      paired.map((item) => item.extensionId),
      NM_BROWSER_KEYS,
    )
    const browsers = changes
      .filter((change) =>
        ['created', 'updated', 'unchanged'].includes(change.action),
      )
      .map((change) => change.browser)
    return browsers.length === 0 &&
      changes.some((change) => change.reason === 'no-host')
      ? { browsers, reason: 'no-host' }
      : { browsers }
  }

  /** After a user-approved pairing is stored: its extension stays admitted. */
  async pairingApproved(extensionId: string): Promise<void> {
    await this.maintainManifests((manifests, pairings) =>
      manifests.register(
        extensionId,
        pairings.map((item) => item.extensionId),
      ),
    )
  }

  /** Manifest upkeep is best effort; it never fails pairing or startup. */
  private async maintainManifests(
    update: (
      manifests: NmHostManifests,
      pairings: readonly PairingSummary[],
    ) => Promise<readonly NmManifestChange[]>,
  ): Promise<void> {
    const manifests = this.manifests
    if (!manifests) return
    try {
      const changes = await update(manifests, await this.pairings.list())
      for (const change of changes)
        if (change.action === 'failed')
          console.warn(
            `Native Messaging manifest for ${change.browser} could not be updated`,
          )
    } catch (cause) {
      console.warn(
        `Native Messaging manifest upkeep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  async request(
    pairingId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const connection = [...this.connections].find(
      (item) => item.pairingId === pairingId && item.isReady,
    )
    if (!connection) throw codeError('DRIVER_UNAVAILABLE')
    return connection.request(method, params, timeoutMs, signal)
  }

  private unavailable: string | null = null

  get isListening(): boolean {
    return this.server !== null && !this.stopping
  }

  /** Why the bridge is not listening (another Emperor holds the socket, …). */
  get unavailableReason(): string | null {
    return this.unavailable
  }

  /**
   * Start, or remember why not. The Chrome/Edge connection is optional: a
   * second Emperor instance or a bad run directory must never stop the app
   * from starting; the external driver reports the reason instead.
   */
  async startOrDegrade(): Promise<boolean> {
    if (this.stopping) return false
    if (this.startAttempt) return this.startAttempt
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const attempt = (async () => {
      try {
        await this.start()
        return true
      } catch (error) {
        this.unavailable =
          error instanceof Error ? error.message : String(error)
        if (
          this.unavailable === 'Native Messaging socket is already in use' &&
          !this.stopping &&
          this.retryMs > 0
        ) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            void this.startOrDegrade()
          }, this.retryMs)
          this.retryTimer.unref()
        }
        return false
      }
    })()
    this.startAttempt = attempt
    try {
      return await attempt
    } finally {
      if (this.startAttempt === attempt) this.startAttempt = null
    }
  }

  async start(): Promise<void> {
    if (this.server) return
    if (process.platform !== 'darwin' || process.getuid === undefined)
      throw new Error('Native Messaging bridge is macOS-only')
    const directory = dirname(this.socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error(
        'Native Messaging run directory must be owned by this user and mode 0700',
      )
    try {
      const existing = await lstat(this.socketPath)
      if (
        !existing.isSocket() ||
        existing.isSymbolicLink() ||
        existing.uid !== process.getuid()
      )
        throw new Error('unsafe Native Messaging socket path')
      const live = await new Promise<boolean>((resolve) => {
        const probe = createConnection(this.socketPath)
        probe.once('connect', () => {
          probe.destroy()
          resolve(true)
        })
        probe.once('error', (cause: NodeJS.ErrnoException) =>
          resolve(cause.code !== 'ECONNREFUSED'),
        )
      })
      if (live) throw new Error('Native Messaging socket is already in use')
      await unlink(this.socketPath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    const server = createServer((socket) => {
      if (this.stopping) socket.destroy()
      else this.connections.add(new NmConnection(this, socket))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(this.socketPath, 0o600)
      this.socketInode = (await lstat(this.socketPath)).ino
      this.server = server
      this.unavailable = null
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
    } catch (cause) {
      server.close()
      throw cause
    }
    // Only the instance that owns the socket may repoint manifests (01 §11):
    // a second, degraded Emperor must not steal the browser's host.
    await this.maintainManifests((manifests, pairings) =>
      manifests.reconcile(pairings.map((item) => item.extensionId)),
    )
  }

  connectionClosed(connection: NmConnection): void {
    this.connections.delete(connection)
    if (
      connection.pairingId &&
      ![...this.connections].some(
        (item) => item.pairingId === connection.pairingId && item.isReady,
      )
    )
      this.notify({ type: 'disconnected', pairingId: connection.pairingId })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.startAttempt
    const server = this.server
    if (!server) return
    for (const connection of [...this.connections]) connection.destroy()
    while (this.ownedOperations.size > 0)
      await Promise.allSettled([...this.ownedOperations])
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      const info = await lstat(this.socketPath)
      if (
        info.isSocket() &&
        info.uid === process.getuid?.() &&
        info.ino === this.socketInode
      )
        await unlink(this.socketPath)
    } catch {
      /* already gone */
    }
    this.socketInode = null
  }
}
