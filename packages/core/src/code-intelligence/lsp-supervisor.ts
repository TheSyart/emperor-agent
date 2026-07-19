import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ManagedOwnedProcessRequest,
  OwnedProcessHandle,
  OwnedProcessRuntime,
} from '../processes/runtime'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import { LspContentLengthDecoder, encodeLspMessage } from './lsp-protocol'
import { MAX_CODE_GRAPH_FILE_BYTES } from './models'

const MAX_LSP_RESTARTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const LSP_OUTPUT_QUOTA_BYTES = 8 * 1024 * 1024

export type TrustedLspServerSource =
  | { kind: 'system' | 'managed' | 'user'; identity: string }
  | {
      kind: 'verified_plugin'
      identity: string
      verificationDigest: string
    }

/** Descriptors are constructed by trusted composition roots, never project files. */
export interface TrustedLspServerDescriptor {
  id: string
  source: TrustedLspServerSource
  executable: string
  args: readonly string[]
  extensions: readonly string[]
  languageId: string
  maxRestarts?: number
  env?: Readonly<Record<string, string>>
}

interface NormalizedLspServerDescriptor extends Omit<
  TrustedLspServerDescriptor,
  'extensions' | 'maxRestarts'
> {
  extensions: readonly string[]
  maxRestarts: number
}

export interface LspTargetInput {
  workspaceRoot: string
  sessionId: string
  filePath: string
}

export interface LspRequestInput extends LspTargetInput {
  method: string
  params: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export interface LspSyncDocumentInput extends LspTargetInput {
  text: string
  version: number
}

export type LspInstanceState =
  'idle' | 'starting' | 'ready' | 'crashed' | 'failed' | 'stopping'

export interface LspSupervisorDiagnostics {
  keyDigest: string
  descriptorId: string
  sourceKind: TrustedLspServerSource['kind']
  state: LspInstanceState
  starts: number
  restarts: number
  crashes: number
  generation: number
  pendingRequests: number
  openDocuments: number
  ignoredNotifications: number
  protocolErrors: number
  lastError: string | null
}

export interface LspSupervisorOptions {
  processRuntime: Pick<OwnedProcessRuntime, 'spawn'>
  stateRoot: string
  descriptors: readonly TrustedLspServerDescriptor[]
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  signal: AbortSignal | null
  onAbort: (() => void) | null
}

interface LspInstance {
  keyDigest: string
  descriptor: NormalizedLspServerDescriptor
  workspaceRoot: string
  sessionId: string
  scratchRoot: string
  state: LspInstanceState
  handle: OwnedProcessHandle | null
  startPromise: Promise<void> | null
  generation: number
  starts: number
  restarts: number
  crashes: number
  nextRequestId: number
  pending: Map<string, PendingRequest>
  decoder: LspContentLengthDecoder
  openDocuments: Map<string, { version: number; contentDigest: string }>
  ignoredNotifications: number
  protocolErrors: number
  lastError: string | null
  stopping: boolean
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

/** Lazy, session-scoped owner of trusted LSP stdio children. */
export class LspSupervisor {
  private readonly processRuntime: Pick<OwnedProcessRuntime, 'spawn'>
  private readonly stateRoot: string
  private readonly descriptors: readonly NormalizedLspServerDescriptor[]
  private readonly instances = new Map<string, LspInstance>()

  constructor(opts: LspSupervisorOptions) {
    this.processRuntime = opts.processRuntime
    this.stateRoot = resolve(opts.stateRoot)
    this.descriptors = Object.freeze(opts.descriptors.map(normalizeDescriptor))
    const ids = new Set<string>()
    const extensions = new Set<string>()
    for (const descriptor of this.descriptors) {
      if (ids.has(descriptor.id))
        throw new Error(`Duplicate trusted LSP descriptor: ${descriptor.id}`)
      ids.add(descriptor.id)
      for (const extension of descriptor.extensions) {
        if (extensions.has(extension))
          throw new Error(
            `Trusted LSP extension collision is not allowed: ${extension}`,
          )
        extensions.add(extension)
      }
    }
  }

  async request<T = unknown>(input: LspRequestInput): Promise<T> {
    validateMethod(input.method)
    throwIfAborted(input.signal)
    const instance = await this.acquire(input)
    await this.ensureReady(instance)
    throwIfAborted(input.signal)
    return (await this.sendRequest(instance, input.method, input.params, {
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    })) as T
  }

  async syncDocument(input: LspSyncDocumentInput): Promise<void> {
    if (!Number.isSafeInteger(input.version) || input.version < 0)
      throw new Error('LSP document version must be a non-negative integer')
    if (Buffer.byteLength(input.text, 'utf8') > MAX_CODE_GRAPH_FILE_BYTES)
      throw new Error('LSP document exceeds the 5 MiB file limit')
    const instance = await this.acquire(input)
    await this.ensureReady(instance)
    const canonicalFile = await canonicalFileWithin(
      instance.workspaceRoot,
      input.filePath,
    )
    const uri = pathToFileURL(canonicalFile).href
    const previous = instance.openDocuments.get(uri)
    const contentDigest = sha256(input.text)
    if (previous === undefined) {
      await this.sendNotification(instance, 'textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: instance.descriptor.languageId,
          version: input.version,
          text: input.text,
        },
      })
    } else {
      if (
        input.version === previous.version &&
        contentDigest === previous.contentDigest
      )
        return
      if (input.version <= previous.version)
        throw new Error('LSP document versions must increase monotonically')
      await this.sendNotification(instance, 'textDocument/didChange', {
        textDocument: { uri, version: input.version },
        contentChanges: [{ text: input.text }],
      })
    }
    instance.openDocuments.set(uri, { version: input.version, contentDigest })
  }

  diagnostics(): LspSupervisorDiagnostics[] {
    return [...this.instances.values()]
      .sort((left, right) => left.keyDigest.localeCompare(right.keyDigest))
      .map((instance) => ({
        keyDigest: instance.keyDigest,
        descriptorId: instance.descriptor.id,
        sourceKind: instance.descriptor.source.kind,
        state: instance.state,
        starts: instance.starts,
        restarts: instance.restarts,
        crashes: instance.crashes,
        generation: instance.generation,
        pendingRequests: instance.pending.size,
        openDocuments: instance.openDocuments.size,
        ignoredNotifications: instance.ignoredNotifications,
        protocolErrors: instance.protocolErrors,
        lastError: instance.lastError,
      }))
  }

  async stopSession(sessionId: string): Promise<void> {
    const targets = [...this.instances.values()].filter(
      (instance) => instance.sessionId === sessionId,
    )
    await Promise.all(targets.map((instance) => this.stopInstance(instance)))
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.instances.values()].map((instance) =>
        this.stopInstance(instance),
      ),
    )
  }

  private async acquire(input: LspTargetInput): Promise<LspInstance> {
    const sessionId = cleanIdentifier(input.sessionId, 'LSP session id')
    const workspaceRoot = await realpath(resolve(input.workspaceRoot))
    await canonicalFileWithin(workspaceRoot, input.filePath)
    const extension = extname(input.filePath).toLowerCase()
    const descriptor = this.descriptors.find((candidate) =>
      candidate.extensions.includes(extension),
    )
    if (!descriptor)
      throw new Error(
        `No trusted LSP descriptor handles ${extension || 'file'}`,
      )
    const keyDigest = sha256(
      [
        workspaceRoot,
        sessionId,
        descriptor.id,
        descriptor.source.identity,
      ].join('\0'),
    )
    const existing = this.instances.get(keyDigest)
    if (existing) return existing
    const scratchRoot = join(
      this.stateRoot,
      'code-intelligence',
      'lsp',
      keyDigest,
    )
    const created: LspInstance = {
      keyDigest,
      descriptor,
      workspaceRoot,
      sessionId,
      scratchRoot,
      state: 'idle',
      handle: null,
      startPromise: null,
      generation: 0,
      starts: 0,
      restarts: 0,
      crashes: 0,
      nextRequestId: 0,
      pending: new Map(),
      decoder: new LspContentLengthDecoder(),
      openDocuments: new Map(),
      ignoredNotifications: 0,
      protocolErrors: 0,
      lastError: null,
      stopping: false,
    }
    this.instances.set(keyDigest, created)
    return created
  }

  private async ensureReady(instance: LspInstance): Promise<void> {
    if (instance.state === 'ready') return
    if (instance.startPromise) return await instance.startPromise
    if (instance.stopping) throw new Error('LSP instance is stopping')
    if (
      instance.starts > 0 &&
      instance.restarts >= instance.descriptor.maxRestarts
    ) {
      instance.state = 'failed'
      instance.lastError = `LSP restart limit reached (${instance.descriptor.maxRestarts})`
      throw new Error(instance.lastError)
    }
    const startPromise = this.startInstance(instance)
    instance.startPromise = startPromise
    try {
      await startPromise
    } finally {
      if (instance.startPromise === startPromise) instance.startPromise = null
    }
  }

  private async startInstance(instance: LspInstance): Promise<void> {
    instance.state = 'starting'
    instance.stopping = false
    if (instance.starts > 0) instance.restarts += 1
    instance.starts += 1
    instance.generation += 1
    const generation = instance.generation
    instance.decoder = new LspContentLengthDecoder()
    instance.openDocuments = new Map()
    await mkdir(instance.scratchRoot, { recursive: true, mode: 0o700 })
    let handle: OwnedProcessHandle
    try {
      handle = await this.processRuntime.spawn(
        this.spawnRequest(instance, generation),
      )
    } catch (error) {
      const message = cleanError(error, 'LSP process failed to start')
      instance.state = 'crashed'
      instance.crashes += 1
      instance.lastError = message
      throw new Error(message)
    }
    if (instance.stopping || generation !== instance.generation) {
      handle.cancel('stale LSP generation')
      throw new Error('LSP generation became stale while starting')
    }
    instance.handle = handle
    handle.stdout.on('data', (chunk: Buffer | string) =>
      this.onData(instance, generation, chunk),
    )
    handle.stdout.on('error', (error) =>
      this.protocolFailure(instance, generation, error),
    )
    handle.stdin.on('error', (error) =>
      this.protocolFailure(instance, generation, error),
    )
    void handle.settled.then(
      (result) =>
        this.onSettled(
          instance,
          generation,
          result.error ??
            `LSP process exited (status=${result.status}, code=${String(result.exitCode)})`,
        ),
      (error) => this.onSettled(instance, generation, cleanError(error)),
    )
    try {
      await this.sendRequest(instance, 'initialize', {
        processId: process.pid,
        clientInfo: { name: 'Emperor Agent' },
        rootUri: pathToFileURL(instance.workspaceRoot).href,
        workspaceFolders: [
          {
            uri: pathToFileURL(instance.workspaceRoot).href,
            name: 'workspace',
          },
        ],
        capabilities: {},
      })
      await this.sendNotification(instance, 'initialized', {})
      if (instance.handle !== handle || instance.generation !== generation)
        throw new Error('LSP process exited during initialization')
      instance.state = 'ready'
      instance.lastError = null
    } catch (error) {
      if (instance.handle === handle) handle.cancel('LSP initialization failed')
      instance.state = 'crashed'
      instance.lastError = cleanError(error)
      throw error
    }
  }

  private spawnRequest(
    instance: LspInstance,
    generation: number,
  ): ManagedOwnedProcessRequest {
    const descriptor = instance.descriptor
    return {
      executable: descriptor.executable,
      args: [...descriptor.args],
      cwd: instance.scratchRoot,
      env: lspEnvironment(instance.scratchRoot, descriptor.env),
      owner: {
        kind: 'lsp',
        id: `${instance.keyDigest}:${generation}`,
        sessionId: instance.sessionId,
      },
      maxOutputBytes: LSP_OUTPUT_QUOTA_BYTES,
      outputPolicy: 'truncate_tail',
      outputQuotaScope: 'combined',
      containment: {
        mode: 'required',
        workspaceRoot: instance.scratchRoot,
        stateRoot: null,
        tempRoot: instance.scratchRoot,
        readOnlyRoots: [instance.workspaceRoot],
        network: 'deny',
      },
    }
  }

  private async sendRequest(
    instance: LspInstance,
    method: string,
    params: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const handle = instance.handle
    if (!handle) throw new Error('LSP process is not connected')
    throwIfAborted(opts.signal)
    const id = `${instance.generation}:${++instance.nextRequestId}`
    const timeoutMs = boundedTimeout(opts.timeoutMs)
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const signal = opts.signal ?? null
      const pending: PendingRequest = {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null,
        signal,
        onAbort: null,
      }
      const finishWithError = (error: Error, notifyCancellation: boolean) => {
        if (!this.takePending(instance, id, pending)) return
        if (notifyCancellation)
          void this.sendNotification(instance, '$/cancelRequest', { id }).catch(
            () => undefined,
          )
        rejectPromise(error)
      }
      pending.onAbort = () =>
        finishWithError(new Error('LSP request cancelled'), true)
      if (signal)
        signal.addEventListener('abort', pending.onAbort, { once: true })
      pending.timer = setTimeout(
        () =>
          finishWithError(
            new Error(`LSP request timed out after ${timeoutMs}ms`),
            true,
          ),
        timeoutMs,
      )
      pending.timer.unref?.()
      instance.pending.set(id, pending)
      void this.sendMessage(instance, {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }).catch((error) => finishWithError(new Error(cleanError(error)), false))
    })
  }

  private async sendNotification(
    instance: LspInstance,
    method: string,
    params: unknown,
  ): Promise<void> {
    await this.sendMessage(instance, { jsonrpc: '2.0', method, params })
  }

  private async sendMessage(
    instance: LspInstance,
    message: JsonRpcMessage,
  ): Promise<void> {
    const stdin = instance.handle?.stdin
    if (!stdin) throw new Error('LSP process is not connected')
    const frame = encodeLspMessage(message)
    if (stdin.write(frame)) return
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onDrain = () => {
        cleanup()
        resolvePromise()
      }
      const onError = (error: Error) => {
        cleanup()
        rejectPromise(error)
      }
      const cleanup = () => {
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
    })
  }

  private onData(
    instance: LspInstance,
    generation: number,
    chunk: Buffer | string,
  ): void {
    if (instance.generation !== generation) return
    try {
      for (const raw of instance.decoder.append(chunk))
        this.onMessage(instance, generation, raw as JsonRpcMessage)
    } catch (error) {
      this.protocolFailure(instance, generation, error)
    }
  }

  private onMessage(
    instance: LspInstance,
    generation: number,
    message: JsonRpcMessage,
  ): void {
    if (instance.generation !== generation) return
    const id = validRpcId(message.id)
    if (id !== null && ('result' in message || 'error' in message)) {
      const pending = instance.pending.get(id)
      if (!pending || !this.takePending(instance, id, pending)) return
      if ('error' in message && message.error !== undefined)
        pending.reject(
          new Error(`LSP server error: ${safeJson(message.error)}`),
        )
      else pending.resolve(message.result)
      return
    }
    if (id !== null && typeof message.method === 'string') {
      if (message.method === 'workspace/configuration') {
        const params = message.params as { items?: unknown } | null
        const items = Array.isArray(params?.items) ? params.items : []
        void this.sendMessage(instance, {
          jsonrpc: '2.0',
          id: message.id,
          result: items.map(() => null),
        }).catch(() => undefined)
        return
      }
      void this.sendMessage(instance, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported by client' },
      }).catch(() => undefined)
      return
    }
    if (typeof message.method === 'string') instance.ignoredNotifications += 1
  }

  private protocolFailure(
    instance: LspInstance,
    generation: number,
    cause: unknown,
  ): void {
    if (instance.generation !== generation || instance.stopping) return
    const error = new Error(`LSP protocol violation: ${cleanError(cause)}`)
    instance.protocolErrors += 1
    instance.lastError = error.message
    instance.state = 'crashed'
    this.failPending(instance, error)
    const handle = instance.handle
    instance.handle = null
    handle?.cancel('LSP protocol violation')
  }

  private onSettled(
    instance: LspInstance,
    generation: number,
    reason: string,
  ): void {
    if (instance.generation !== generation || instance.stopping) return
    instance.handle = null
    instance.state = 'crashed'
    instance.crashes += 1
    instance.lastError = reason.slice(0, 500)
    this.failPending(instance, new Error(instance.lastError))
  }

  private takePending(
    instance: LspInstance,
    id: string,
    pending: PendingRequest,
  ): boolean {
    if (instance.pending.get(id) !== pending) return false
    instance.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort)
      pending.signal.removeEventListener('abort', pending.onAbort)
    return true
  }

  private failPending(instance: LspInstance, error: Error): void {
    for (const [id, pending] of [...instance.pending]) {
      if (!this.takePending(instance, id, pending)) continue
      pending.reject(error)
    }
  }

  private async stopInstance(instance: LspInstance): Promise<void> {
    if (!this.instances.has(instance.keyDigest)) return
    instance.stopping = true
    instance.state = 'stopping'
    const handle = instance.handle
    this.failPending(instance, new Error('LSP instance stopped'))
    if (handle) {
      try {
        await this.sendRequest(instance, 'shutdown', null, { timeoutMs: 500 })
        await this.sendNotification(instance, 'exit', null)
      } catch {
        // Cancellation below remains the authoritative process cleanup path.
      }
      const exited = await settlesWithin(handle, 250)
      if (!exited) handle.cancel('LSP supervisor stopped')
      await handle.settled.catch(() => undefined)
    }
    instance.handle = null
    this.instances.delete(instance.keyDigest)
  }
}

async function settlesWithin(
  handle: OwnedProcessHandle,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      handle.settled.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeDescriptor(
  descriptor: TrustedLspServerDescriptor,
): NormalizedLspServerDescriptor {
  if (!descriptor || typeof descriptor !== 'object')
    throw new Error('Trusted LSP descriptor is required')
  const id = cleanIdentifier(descriptor.id, 'LSP descriptor id')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id))
    throw new Error('Trusted LSP descriptor id is invalid')
  const source = descriptor.source as Record<string, unknown> | null | undefined
  const kind = source?.kind
  if (!['system', 'managed', 'user', 'verified_plugin'].includes(String(kind)))
    throw new Error('LSP descriptors must come from a trusted source')
  const identity = cleanIdentifier(source?.identity, 'LSP source identity')
  let normalizedSource: TrustedLspServerSource
  if (kind === 'verified_plugin') {
    const verificationDigest = String(source?.verificationDigest ?? '')
    if (!/^[a-f0-9]{64}$/i.test(verificationDigest))
      throw new Error('Verified LSP plugin requires a verification digest')
    normalizedSource = { kind, identity, verificationDigest }
  } else {
    normalizedSource = {
      kind: kind as 'system' | 'managed' | 'user',
      identity,
    }
  }
  if (!isAbsolute(descriptor.executable))
    throw new Error('Trusted LSP executable must be an absolute path')
  if (!Array.isArray(descriptor.args) || descriptor.args.length > 64)
    throw new Error('Trusted LSP args are invalid')
  const args = Object.freeze(
    descriptor.args.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 4_096)
        throw new Error('Trusted LSP argument is invalid')
      return arg
    }),
  )
  if (!Array.isArray(descriptor.extensions) || descriptor.extensions.length < 1)
    throw new Error('Trusted LSP descriptor requires file extensions')
  const extensions = Object.freeze(
    [...new Set(descriptor.extensions.map(normalizeExtension))].sort(),
  )
  const languageId = cleanIdentifier(descriptor.languageId, 'LSP language id')
  const maxRestarts = boundedRestarts(descriptor.maxRestarts)
  const env = normalizeEnvironment(descriptor.env)
  return Object.freeze({
    id,
    source: normalizedSource,
    executable: descriptor.executable,
    args,
    extensions,
    languageId,
    maxRestarts,
    env,
  })
}

async function canonicalFileWithin(
  workspaceRoot: string,
  filePath: string,
): Promise<string> {
  const requested = resolve(filePath)
  const canonicalCandidate = canonicalizeExistingPath(requested)
  if (!isPathWithin(canonicalCandidate, workspaceRoot))
    throw new Error('LSP file is outside the workspace')
  const canonical = await realpath(requested)
  if (!isPathWithin(canonical, workspaceRoot))
    throw new Error('LSP file resolves outside the workspace')
  const fileStats = await stat(canonical)
  if (!fileStats.isFile()) throw new Error('LSP target is not a regular file')
  if (fileStats.size > MAX_CODE_GRAPH_FILE_BYTES)
    throw new Error('LSP file exceeds the 5 MiB file limit')
  return canonical
}

function lspEnvironment(
  scratchRoot: string,
  descriptorEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: scratchRoot,
    TMPDIR: scratchRoot,
    XDG_CACHE_HOME: scratchRoot,
    XDG_CONFIG_HOME: scratchRoot,
  }
  for (const key of ['PATH', 'LANG', 'LC_ALL'] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  for (const [key, value] of Object.entries(descriptorEnv ?? {})) {
    env[key] = value
  }
  return env
}

function normalizeEnvironment(
  value?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Trusted LSP environment is invalid')
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof raw !== 'string' ||
      raw.length > 16_384
    )
      throw new Error('Trusted LSP environment entry is invalid')
    env[key] = raw
  }
  return Object.freeze(env)
}

function normalizeExtension(value: string): string {
  const extension = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!/^\.[a-z0-9]+$/.test(extension))
    throw new Error(`Invalid trusted LSP extension: ${extension}`)
  return extension
}

function boundedRestarts(value: number | undefined): number {
  if (value === undefined) return MAX_LSP_RESTARTS
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LSP_RESTARTS)
    throw new Error(`LSP maxRestarts must be between 0 and ${MAX_LSP_RESTARTS}`)
  return value
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 10)
    return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(value, MAX_REQUEST_TIMEOUT_MS)
}

function validRpcId(value: unknown): string | null {
  if (typeof value === 'string' && value.length <= 128) return value
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value)
  return null
}

function validateMethod(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('LSP method is invalid')
}

function cleanIdentifier(value: unknown, label: string): string {
  const cleaned = String(value ?? '').trim()
  if (!cleaned || cleaned.length > 256) throw new Error(`${label} is invalid`)
  return cleaned
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new Error('LSP request cancelled')
}

function cleanError(error: unknown, fallback = 'LSP operation failed'): string {
  const value = error instanceof Error ? error.message : String(error ?? '')
  return value.trim().slice(0, 500) || fallback
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500)
  } catch {
    return 'unknown error'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
