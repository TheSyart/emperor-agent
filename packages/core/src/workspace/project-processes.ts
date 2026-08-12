import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { EmperorError } from '../errors'
import type {
  OwnedProcessHandle,
  OwnedProcessRuntime,
} from '../processes/runtime'
import {
  ProjectLaunchCandidateDetector,
  ProjectLaunchCandidateError,
  type ProjectLaunchCandidate,
  type ProjectLaunchEcosystem,
} from './project-launch-candidates'
import {
  startStaticProjectHost,
  type StaticProjectHost,
} from './static-project-host'
import {
  WebsitePreviewRegistry,
  type WebsitePreviewDescriptor,
} from './website-previews'

const MAX_ACTIVE_PER_SESSION = 4
const MAX_LOG_BYTES = 256 * 1024
const MAX_LOG_CHUNKS = 1_000
const MAX_RECEIPTS = 512

export type ProjectProcessStatus =
  'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type ProjectProcessHealth =
  'none' | 'probing' | 'ready' | 'unreachable' | 'stopped'

export interface ProjectProcessDescriptor {
  id: string
  sessionId: string
  candidateId: string
  name: string
  ecosystem: ProjectLaunchEcosystem
  status: ProjectProcessStatus
  health: ProjectProcessHealth
  revision: number
  primary: boolean
  startedAt: number
  finishedAt: number | null
  errorSummary?: string
  preview: WebsitePreviewDescriptor | null
}

export interface ProjectProcessOutputChunk {
  seq: number
  stream: 'stdout' | 'stderr'
  data: string
}

export interface ProjectProcessServiceOptions {
  stateRoot: string
  resolveProjectRoot(sessionId: string): string
  resolveEnvironment(projectRoot: string): Promise<{
    toolPaths: Readonly<Record<string, string | undefined>>
    env: Readonly<Record<string, string>>
  }>
  processRuntime?: Pick<OwnedProcessRuntime, 'spawn'>
  detector?: ProjectLaunchCandidateDetector
  previewRegistry?: WebsitePreviewRegistry
  allocatePort?: () => Promise<number>
  /** Delays used while waiting for an initial loopback health receipt. */
  previewProbeDelaysMs?: readonly number[]
  startStaticHost?: (input: {
    projectRoot: string
    port: number
  }) => Promise<StaticProjectHost>
  emit?: (
    sessionId: string,
    event: Record<string, unknown>,
  ) => void | Promise<void>
  now?: () => number
}

interface PrivateRecord extends ProjectProcessDescriptor {
  invocationId: string
}

interface LiveRecord {
  handle: OwnedProcessHandle | null
  staticHost: StaticProjectHost | null
}

interface OutputBuffer {
  nextSeq: number
  bytes: number
  chunks: ProjectProcessOutputChunk[]
  truncated: boolean
}

export type ProjectProcessErrorCode =
  | 'project_process_candidate_invalid'
  | 'project_process_candidate_unavailable'
  | 'project_process_limit'
  | 'project_process_owner_invalid'
  | 'project_process_stale'
  | 'project_process_not_running'
  | 'project_process_runtime_unavailable'

export class ProjectProcessError extends EmperorError {
  constructor(code: ProjectProcessErrorCode, message: string) {
    super(message, code)
  }
}

/** Core-owned project process state and capability boundary. */
export class ProjectProcessService {
  readonly receiptsPath: string
  readonly previews: WebsitePreviewRegistry
  private readonly detector: ProjectLaunchCandidateDetector
  private readonly records = new Map<string, PrivateRecord>()
  private readonly live = new Map<string, LiveRecord>()
  private readonly output = new Map<string, OutputBuffer>()
  private readonly invocationResults = new Map<string, string>()
  private readonly now: () => number
  private readonly allocatePort: () => Promise<number>
  private readonly previewProbeDelaysMs: readonly number[]
  private readonly startStaticHost: NonNullable<
    ProjectProcessServiceOptions['startStaticHost']
  >

  constructor(private readonly opts: ProjectProcessServiceOptions) {
    this.detector = opts.detector ?? new ProjectLaunchCandidateDetector()
    this.previews = opts.previewRegistry ?? new WebsitePreviewRegistry()
    this.now = opts.now ?? Date.now
    this.allocatePort = opts.allocatePort ?? allocateLoopbackPort
    this.previewProbeDelaysMs = opts.previewProbeDelaysMs ?? [250, 500, 1_000]
    this.startStaticHost = opts.startStaticHost ?? startStaticProjectHost
    this.receiptsPath = join(
      resolve(opts.stateRoot),
      'project-processes',
      'receipts.v1.json',
    )
    this.loadReceipts()
  }

  async candidates(sessionId: string): Promise<ProjectLaunchCandidate[]> {
    const projectRoot = this.projectRoot(sessionId)
    const environment = await this.opts.resolveEnvironment(projectRoot)
    return this.detector.detect({
      projectRoot,
      toolPaths: environment.toolPaths,
    })
  }

  list(sessionIdValue: string): ProjectProcessDescriptor[] {
    const sessionId = requiredId(sessionIdValue, 'session')
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(publicRecord)
  }

  get(processId: string, sessionId: string): ProjectProcessDescriptor {
    return publicRecord(this.requireOwned(processId, sessionId))
  }

  async start(input: {
    sessionId: string
    candidateId: string
    invocationId: string
    primary?: boolean
  }): Promise<ProjectProcessDescriptor> {
    const sessionId = requiredId(input.sessionId, 'session')
    const invocationId = requiredId(input.invocationId, 'invocation')
    const invocationKey = `${sessionId}\0${invocationId}`
    const existingId = this.invocationResults.get(invocationKey)
    if (existingId) {
      const existing = this.records.get(existingId)
      if (existing) return publicRecord(existing)
    }
    const activeCount = [...this.records.values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        ['starting', 'running'].includes(record.status),
    ).length
    if (activeCount >= MAX_ACTIVE_PER_SESSION)
      throw new ProjectProcessError(
        'project_process_limit',
        '当前会话最多运行 4 个项目进程。',
      )

    const projectRoot = this.projectRoot(sessionId)
    const environment = await this.opts.resolveEnvironment(projectRoot)
    const port = await this.allocatePort()
    let launch
    try {
      launch = this.detector.resolve({
        projectRoot,
        toolPaths: environment.toolPaths,
        candidateId: String(input.candidateId ?? ''),
        port,
      })
    } catch (error) {
      if (error instanceof ProjectLaunchCandidateError)
        throw new ProjectProcessError(
          error.code === 'project_launch_candidate_unavailable'
            ? 'project_process_candidate_unavailable'
            : 'project_process_candidate_invalid',
          error.message,
        )
      throw error
    }

    const id = `project_process_${launch.ecosystem}_${randomBytes(12).toString('hex')}`
    const record: PrivateRecord = {
      id,
      sessionId,
      candidateId: launch.candidateId,
      invocationId,
      name: launch.name,
      ecosystem: launch.ecosystem,
      status: 'starting',
      health: launch.previewCapable ? 'probing' : 'none',
      revision: 1,
      primary: input.primary ?? activeCount === 0,
      startedAt: this.now(),
      finishedAt: null,
      preview: null,
    }
    this.records.set(id, record)
    this.invocationResults.set(invocationKey, id)
    this.output.set(id, emptyOutput())
    this.persistReceipts()
    await this.publish(record)

    try {
      if (launch.kind === 'static') {
        const staticHost = await this.startStaticHost({ projectRoot, port })
        this.live.set(id, { handle: null, staticHost })
        record.status = 'running'
        record.preview = await this.previews.register({
          sessionId,
          processId: id,
          revision: record.revision,
          title: record.name,
          url: staticHost.url,
          primary: record.primary,
        })
        record.health = previewHealth(record.preview)
      } else {
        if (!this.opts.processRuntime)
          throw new ProjectProcessError(
            'project_process_runtime_unavailable',
            '项目进程运行时不可用。',
          )
        const tempRoot = join(
          resolve(this.opts.stateRoot),
          'project-processes',
          'tmp',
        )
        mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
        const handle = await this.opts.processRuntime.spawn({
          executable: launch.executable,
          args: launch.args,
          cwd: launch.cwd,
          env: { ...environment.env, ...launch.env },
          maxOutputBytes: 512 * 1024,
          outputPolicy: 'truncate_tail',
          outputQuotaScope: 'combined',
          owner: { kind: 'session', id, sessionId },
          execution: {
            kind: 'sandbox',
            policy: {
              mode: 'required',
              workspaceRoot: projectRoot,
              stateRoot: resolve(this.opts.stateRoot),
              tempRoot,
              readOnlyRoots: [],
              network: 'allow',
            },
          },
        })
        this.live.set(id, { handle, staticHost: null })
        record.status = 'running'
        this.captureStream(record, handle.stdout, 'stdout')
        this.captureStream(record, handle.stderr, 'stderr')
        void handle.settled.then((result) => {
          void this.onChildSettled(record.id, result.status, result.exitCode)
        })
        // Do not return a successful start receipt before the bounded initial
        // health probe settles. The process remains running when it is not yet
        // reachable, but callers cannot mistake that state for a ready site.
        await this.probeAssignedPort(record.id, port)
      }
      this.persistReceipts()
      await this.publish(record)
      return publicRecord(record)
    } catch (error) {
      record.status = 'failed'
      record.health = 'unreachable'
      record.finishedAt = this.now()
      record.errorSummary = safeError(error)
      record.revision += 1
      this.persistReceipts()
      await this.publish(record)
      throw error
    }
  }

  readOutput(input: {
    sessionId: string
    processId: string
    afterSeq?: number
  }): {
    chunks: ProjectProcessOutputChunk[]
    nextSeq: number
    truncated: boolean
  } {
    this.requireOwned(input.processId, input.sessionId)
    const buffer = this.output.get(input.processId) ?? emptyOutput()
    const afterSeq = Math.max(0, Math.trunc(Number(input.afterSeq ?? 0)))
    return {
      chunks: buffer.chunks
        .filter((chunk) => chunk.seq > afterSeq)
        .map((chunk) => ({ ...chunk })),
      nextSeq: buffer.nextSeq - 1,
      truncated: buffer.truncated,
    }
  }

  async stop(input: {
    sessionId: string
    processId: string
    expectedRevision: number
  }): Promise<ProjectProcessDescriptor> {
    const record = this.requireOwned(input.processId, input.sessionId)
    if (record.revision !== input.expectedRevision)
      throw new ProjectProcessError(
        'project_process_stale',
        '项目进程状态已经变化，请刷新后重试。',
      )
    if (!['starting', 'running'].includes(record.status))
      throw new ProjectProcessError(
        'project_process_not_running',
        '项目进程当前未运行。',
      )
    const previousStatus = record.status
    record.status = 'stopped'
    try {
      await this.stopLive(record, 'project process stopped')
    } catch (error) {
      record.status = previousStatus
      throw error
    }
    record.health = 'stopped'
    record.finishedAt = this.now()
    record.revision += 1
    record.preview = this.previews.stopProcess(
      record.sessionId,
      record.id,
      input.expectedRevision,
    )
    this.persistReceipts()
    await this.publish(record)
    return publicRecord(record)
  }

  async restart(input: {
    sessionId: string
    processId: string
    expectedRevision: number
    invocationId: string
  }): Promise<ProjectProcessDescriptor> {
    const record = this.requireOwned(input.processId, input.sessionId)
    if (record.revision !== input.expectedRevision)
      throw new ProjectProcessError(
        'project_process_stale',
        '项目进程状态已经变化，请刷新后重试。',
      )
    if (['starting', 'running'].includes(record.status))
      await this.stop({
        sessionId: input.sessionId,
        processId: input.processId,
        expectedRevision: input.expectedRevision,
      })
    return await this.start({
      sessionId: input.sessionId,
      candidateId: record.candidateId,
      invocationId: input.invocationId,
      primary: record.primary,
    })
  }

  async stopSession(sessionIdValue: string, reason: string): Promise<string[]> {
    const sessionId = requiredId(sessionIdValue, 'session')
    const active = [...this.records.values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        ['starting', 'running'].includes(record.status),
    )
    for (const record of active) {
      const previousStatus = record.status
      record.status = 'stopped'
      try {
        await this.stopLive(record, reason)
      } catch (error) {
        record.status = previousStatus
        throw error
      }
      record.health = 'stopped'
      record.finishedAt = this.now()
      const previousRevision = record.revision
      record.revision += 1
      record.preview = this.previews.stopProcess(
        record.sessionId,
        record.id,
        previousRevision,
      )
      await this.publish(record)
    }
    this.persistReceipts()
    return active.map((record) => record.id)
  }

  async shutdown(reason = 'application exit'): Promise<void> {
    const sessions = new Set(
      [...this.records.values()]
        .filter((record) => ['starting', 'running'].includes(record.status))
        .map((record) => record.sessionId),
    )
    for (const sessionId of sessions) await this.stopSession(sessionId, reason)
  }

  private projectRoot(sessionId: string): string {
    return resolve(
      this.opts.resolveProjectRoot(requiredId(sessionId, 'session')),
    )
  }

  private requireOwned(
    processIdValue: string,
    sessionIdValue: string,
  ): PrivateRecord {
    const processId = requiredId(processIdValue, 'process')
    const sessionId = requiredId(sessionIdValue, 'session')
    const record = this.records.get(processId)
    if (!record || record.sessionId !== sessionId)
      throw new ProjectProcessError(
        'project_process_owner_invalid',
        '项目进程不属于当前会话。',
      )
    return record
  }

  private async stopLive(record: PrivateRecord, reason: string): Promise<void> {
    const live = this.live.get(record.id)
    this.live.delete(record.id)
    live?.handle?.cancel(reason)
    await live?.staticHost?.close()
  }

  private captureStream(
    record: PrivateRecord,
    stream: Readable,
    kind: 'stdout' | 'stderr',
  ): void {
    stream.on('data', (chunk: Buffer | string) => {
      const text = sanitizeLogChunk(chunk)
      if (!text) return
      appendOutput(
        this.output.get(record.id) ?? emptyOutput(),
        kind,
        text,
        (next) => this.output.set(record.id, next),
      )
      const url = firstLoopbackUrl(text)
      if (url) void this.registerPreview(record.id, url)
    })
  }

  private async probeAssignedPort(
    processId: string,
    port: number,
  ): Promise<void> {
    for (const delayMs of this.previewProbeDelaysMs) {
      const record = this.records.get(processId)
      if (!record || record.status !== 'running') return
      if (record.preview?.status === 'ready') return
      if (delayMs > 0)
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, delayMs),
        )
      await this.registerPreview(processId, `http://127.0.0.1:${port}/`)
      if (this.records.get(processId)?.preview?.status === 'ready') return
    }
  }

  private async registerPreview(processId: string, url: string): Promise<void> {
    const record = this.records.get(processId)
    if (!record || record.status !== 'running') return
    try {
      const preview = await this.previews.register({
        sessionId: record.sessionId,
        processId: record.id,
        revision: record.revision,
        title: record.name,
        url,
        primary: record.primary,
      })
      record.preview = preview
      record.health = previewHealth(preview)
      this.persistReceipts()
      await this.publish(record)
    } catch {
      // Printed URLs remain untrusted candidates and never become receipts.
    }
  }

  private async onChildSettled(
    processId: string,
    status: string,
    exitCode: number | null,
  ): Promise<void> {
    const record = this.records.get(processId)
    if (!record || !['starting', 'running'].includes(record.status)) return
    this.live.delete(processId)
    record.status =
      status === 'completed' && exitCode === 0 ? 'completed' : 'failed'
    record.health = 'stopped'
    record.finishedAt = this.now()
    const previousRevision = record.revision
    record.revision += 1
    record.preview = this.previews.stopProcess(
      record.sessionId,
      record.id,
      previousRevision,
    )
    if (record.status === 'failed')
      record.errorSummary = `项目进程已退出${
        exitCode === null ? '' : `（exit ${exitCode}）`
      }`
    this.persistReceipts()
    await this.publish(record)
  }

  private async publish(record: PrivateRecord): Promise<void> {
    await this.opts.emit?.(record.sessionId, {
      event: 'project_process_update',
      process: publicRecord(record),
    })
    if (record.preview)
      await this.opts.emit?.(record.sessionId, {
        event: 'website_preview_update',
        preview: { ...record.preview },
      })
  }

  private loadReceipts(): void {
    if (!existsSync(this.receiptsPath)) return
    try {
      const parsed = JSON.parse(
        readFileSync(this.receiptsPath, 'utf8'),
      ) as unknown
      if (!Array.isArray(parsed)) return
      for (const raw of parsed.slice(-MAX_RECEIPTS)) {
        if (!isPersistedRecord(raw)) continue
        const record: PrivateRecord = {
          ...raw,
          preview: null,
          ...(raw.status === 'starting' || raw.status === 'running'
            ? {
                status: 'interrupted' as const,
                health: 'stopped' as const,
                revision: raw.revision + 1,
                finishedAt: this.now(),
                errorSummary: '应用重启，项目进程未自动恢复。',
              }
            : {}),
        }
        this.records.set(record.id, record)
        this.invocationResults.set(
          `${record.sessionId}\0${record.invocationId}`,
          record.id,
        )
      }
      this.persistReceipts()
    } catch {
      // Corrupt private receipts are ignored and never regain process authority.
    }
  }

  private persistReceipts(): void {
    const root = join(resolve(this.opts.stateRoot), 'project-processes')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const records = [...this.records.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-MAX_RECEIPTS)
      .map((record) => ({ ...record, preview: null }))
    const temp = `${this.receiptsPath}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify(records)}\n`, { mode: 0o600 })
    renameSync(temp, this.receiptsPath)
  }
}

function publicRecord(record: PrivateRecord): ProjectProcessDescriptor {
  const { invocationId: _invocationId, ...safe } = record
  return {
    ...safe,
    preview: safe.preview ? { ...safe.preview } : null,
  }
}

function previewHealth(
  preview: WebsitePreviewDescriptor,
): ProjectProcessHealth {
  if (preview.status === 'ready') return 'ready'
  if (preview.status === 'probing') return 'probing'
  if (preview.status === 'stopped') return 'stopped'
  return 'unreachable'
}

function emptyOutput(): OutputBuffer {
  return { nextSeq: 1, bytes: 0, chunks: [], truncated: false }
}

function appendOutput(
  buffer: OutputBuffer,
  stream: 'stdout' | 'stderr',
  data: string,
  store: (buffer: OutputBuffer) => void,
): void {
  const chunk: ProjectProcessOutputChunk = {
    seq: buffer.nextSeq++,
    stream,
    data,
  }
  buffer.chunks.push(chunk)
  buffer.bytes += Buffer.byteLength(data, 'utf8')
  while (
    buffer.chunks.length > MAX_LOG_CHUNKS ||
    buffer.bytes > MAX_LOG_BYTES
  ) {
    const removed = buffer.chunks.shift()
    if (!removed) break
    buffer.bytes -= Buffer.byteLength(removed.data, 'utf8')
    buffer.truncated = true
  }
  store(buffer)
}

function sanitizeLogChunk(value: Buffer | string): string {
  return redactSensitiveText(
    Buffer.isBuffer(value) ? value.toString('utf8') : value,
  ).slice(0, 16 * 1024)
}

function firstLoopbackUrl(text: string): string | null {
  const matches = text.match(
    /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:\/[^\s]*)?/i,
  )
  return matches?.[0] ?? null
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return redactSensitiveText(message)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 240)
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s]+/gi,
      '$1[redacted]',
    )
    .replace(
      /([?&](?:access[_-]?token|token|api[_-]?key|apikey|key|password|passwd|secret)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(
      /(\b(?:access[_-]?token|token|api[_-]?key|apikey|key|password|passwd|secret)\s*=\s*)[^\s&]+/gi,
      '$1[redacted]',
    )
}

function requiredId(value: string, label: string): string {
  const id = String(value ?? '').trim()
  if (!id || id.length > 256)
    throw new ProjectProcessError(
      'project_process_owner_invalid',
      `Invalid project process ${label} id.`,
    )
  return id
}

function isPersistedRecord(value: unknown): value is PrivateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.candidateId === 'string' &&
    typeof record.invocationId === 'string' &&
    typeof record.name === 'string' &&
    typeof record.ecosystem === 'string' &&
    typeof record.status === 'string' &&
    typeof record.health === 'string' &&
    Number.isInteger(record.revision) &&
    typeof record.startedAt === 'number'
  )
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) rejectPromise(error)
        else if (!port)
          rejectPromise(new Error('Unable to allocate preview port'))
        else resolvePromise(port)
      })
    })
  })
}
