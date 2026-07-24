import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJson, writeJsonAtomic } from '../store/atomic-json'
import { isPathWithin, relativePortable } from '../util/paths'

const RECORD_VERSION = 2
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_DIFF_CELLS = 4_000_000

export type TurnChangeStatus = 'tracking' | 'complete' | 'partial'
export type TurnChangeKind = 'created' | 'modified' | 'deleted' | 'renamed'

export interface TurnChangedFile {
  path: string
  kind: TurnChangeKind
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface TurnChangeSnapshot {
  event: 'turn_change_snapshot'
  version: 2
  turnId: string
  executionId: string
  rootTurnId: string
  activeTurnId: string
  status: TurnChangeStatus
  filesChanged: number
  additions: number
  deletions: number
  binaryFiles: number
  truncated: boolean
  files: TurnChangedFile[]
}

export interface TurnMutationInput {
  sessionId: string
  turnId: string
  executionId?: string
  rootTurnId?: string
  toolCallId: string
  toolName: string
  workspaceRoot: string
  paths: string[]
}

interface PrivateFileSnapshot {
  state: 'absent' | 'file' | 'unsupported'
  hash: string | null
  bytes: number
  binary: boolean
  contentBase64: string | null
  truncated: boolean
}

interface PrivateTurnChangeEntry {
  path: string
  baseline: PrivateFileSnapshot
  ownedCurrent: PrivateFileSnapshot
  attribution: 'precise' | 'partial'
}

interface PrivateTurnChangeRecord {
  version: 2
  sessionId: string
  executionId: string
  rootTurnId: string
  activeTurnId: string
  workspaceRoot: string
  startedAt: string
  updatedAt: string
  entries: PrivateTurnChangeEntry[]
  partialReasons: string[]
}

export class TurnChangeLedger {
  private readonly stateRoot: string
  private readonly maxTextBytes: number
  private readonly maxDiffCells: number
  private readonly locks = new Map<string, Promise<void>>()

  constructor(opts: {
    stateRoot: string
    maxTextBytes?: number
    maxDiffCells?: number
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.maxTextBytes = positiveInt(opts.maxTextBytes, DEFAULT_MAX_TEXT_BYTES)
    this.maxDiffCells = positiveInt(opts.maxDiffCells, DEFAULT_MAX_DIFF_CELLS)
  }

  async capture<T>(
    input: TurnMutationInput,
    effect: () => Promise<T> | T,
    effectSucceeded: (value: T) => boolean = () => true,
  ): Promise<{ value: T; snapshot: TurnChangeSnapshot }> {
    const identity = validateMutationInput(input)
    const paths = normalizedPaths(identity.workspaceRoot, input.paths)
    const precisePaths = await this.withLock(
      identity.sessionId,
      identity.executionId,
      async () => {
        const record = await this.loadOrCreate(identity)
        record.activeTurnId = identity.activeTurnId
        const precise = new Set<string>()
        for (const path of paths) {
          let entry = record.entries.find(
            (candidate) => candidate.path === path.relative,
          )
          const actual = await this.fileSnapshot(path.absolute)
          if (!entry) {
            entry = {
              path: path.relative,
              baseline: actual,
              ownedCurrent: actual,
              attribution: 'precise',
            }
            record.entries.push(entry)
          } else if (!snapshotsEqual(actual, entry.ownedCurrent)) {
            entry.attribution = 'partial'
            addPartialReason(
              record,
              `concurrent_external_edit:${path.relative}`,
            )
          }
          if (entry.attribution === 'precise') precise.add(path.relative)
        }
        record.updatedAt = new Date().toISOString()
        await this.save(record)
        return precise
      },
    )

    let value: T
    try {
      value = await effect()
    } catch (error) {
      await this.recordMutationResult({
        identity,
        paths,
        precisePaths,
        succeeded: false,
      })
      throw error
    }
    await this.recordMutationResult({
      identity,
      paths,
      precisePaths,
      succeeded: effectSucceeded(value),
    })
    const snapshot = await this.snapshot({
      sessionId: identity.sessionId,
      executionId: identity.executionId,
      turnId: identity.activeTurnId,
      status: 'tracking',
    })
    return { value, snapshot: snapshot ?? emptySnapshot(identity) }
  }

  async markPartial(input: {
    sessionId: string
    turnId: string
    executionId?: string
    rootTurnId?: string
    workspaceRoot: string
    reason: string
  }): Promise<TurnChangeSnapshot> {
    const identity = validateMutationInput({
      ...input,
      toolCallId: 'partial',
      toolName: 'unknown',
      paths: [],
    })
    await this.withLock(identity.sessionId, identity.executionId, async () => {
      const record = await this.loadOrCreate(identity)
      record.activeTurnId = identity.activeTurnId
      const reason = String(input.reason || 'unattributed_mutation').trim()
      if (reason) addPartialReason(record, reason)
      record.updatedAt = new Date().toISOString()
      await this.save(record)
    })
    return (
      (await this.snapshot({
        sessionId: identity.sessionId,
        executionId: identity.executionId,
        turnId: identity.activeTurnId,
        status: 'tracking',
      })) ?? emptySnapshot(identity, 'partial')
    )
  }

  async snapshot(input: {
    sessionId: string
    turnId: string
    executionId?: string
    status?: TurnChangeStatus
  }): Promise<TurnChangeSnapshot | null> {
    const executionId = validatedExecutionId(input.executionId, input.turnId)
    return await this.withLock(input.sessionId, executionId, async () => {
      const record = await this.load(input.sessionId, executionId)
      if (!record) return null
      record.activeTurnId = validatedTurnId(input.turnId)
      await this.save(record)
      return await this.project(record, input.status ?? 'tracking')
    })
  }

  async finalize(input: {
    sessionId: string
    turnId: string
    executionId?: string
  }): Promise<TurnChangeSnapshot | null> {
    const executionId = validatedExecutionId(input.executionId, input.turnId)
    return await this.withLock(input.sessionId, executionId, async () => {
      const record = await this.load(input.sessionId, executionId)
      if (!record) return null
      record.activeTurnId = validatedTurnId(input.turnId)
      const snapshot = await this.project(record, 'complete')
      await rm(this.recordPath(input.sessionId, executionId), {
        force: true,
      })
      return snapshot
    })
  }

  private async project(
    record: PrivateTurnChangeRecord,
    requestedStatus: TurnChangeStatus,
  ): Promise<TurnChangeSnapshot> {
    const projected: Array<{
      file: TurnChangedFile
      baselineHash: string | null
      currentHash: string | null
    }> = []
    let truncated = false
    let partial = record.partialReasons.length > 0

    for (const entry of record.entries) {
      const actual = await this.fileSnapshot(
        resolve(record.workspaceRoot, entry.path),
      )
      if (!snapshotsEqual(actual, entry.ownedCurrent)) partial = true
      const current = entry.ownedCurrent
      if (entry.attribution === 'partial') partial = true
      if (
        entry.baseline.state === current.state &&
        entry.baseline.hash === current.hash
      )
        continue
      const result = diffSnapshots(
        entry.path,
        entry.baseline,
        current,
        this.maxDiffCells,
      )
      if (!result) {
        partial = true
        continue
      }
      projected.push({
        file: result.file,
        baselineHash: entry.baseline.hash,
        currentHash: current.hash,
      })
      truncated ||= result.truncated
      partial ||= result.partial
    }

    coalesceRenames(projected)
    projected.sort((left, right) =>
      left.file.path.localeCompare(right.file.path),
    )
    const files = projected.map((item) => item.file)
    const status =
      requestedStatus === 'partial' || partial ? 'partial' : requestedStatus
    return {
      event: 'turn_change_snapshot',
      version: 2,
      turnId: record.activeTurnId,
      executionId: record.executionId,
      rootTurnId: record.rootTurnId,
      activeTurnId: record.activeTurnId,
      status,
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      binaryFiles: files.filter((file) => file.binary).length,
      truncated,
      files,
    }
  }

  private async recordMutationResult(input: {
    identity: ReturnType<typeof validateMutationInput>
    paths: Array<{ absolute: string; relative: string }>
    precisePaths: Set<string>
    succeeded: boolean
  }): Promise<void> {
    await this.withLock(
      input.identity.sessionId,
      input.identity.executionId,
      async () => {
        const record = await this.loadOrCreate(input.identity)
        record.activeTurnId = input.identity.activeTurnId
        for (const path of input.paths) {
          const entry = record.entries.find(
            (candidate) => candidate.path === path.relative,
          )
          if (!entry) continue
          const actual = await this.fileSnapshot(path.absolute)
          if (
            input.succeeded &&
            input.precisePaths.has(path.relative) &&
            entry.attribution === 'precise'
          ) {
            entry.ownedCurrent = actual
            continue
          }
          if (!snapshotsEqual(actual, entry.ownedCurrent)) {
            entry.attribution = 'partial'
            addPartialReason(
              record,
              input.succeeded
                ? `concurrent_external_edit:${path.relative}`
                : `failed_mutation_changed:${path.relative}`,
            )
          }
        }
        record.updatedAt = new Date().toISOString()
        await this.save(record)
      },
    )
  }

  private async loadOrCreate(
    identity: ReturnType<typeof validateMutationInput>,
  ): Promise<PrivateTurnChangeRecord> {
    const existing = await this.load(identity.sessionId, identity.executionId)
    if (existing) {
      if (existing.workspaceRoot !== identity.workspaceRoot)
        throw new Error('turn change ledger workspace mismatch')
      return existing
    }
    const now = new Date().toISOString()
    return {
      version: RECORD_VERSION,
      sessionId: identity.sessionId,
      executionId: identity.executionId,
      rootTurnId: identity.rootTurnId,
      activeTurnId: identity.activeTurnId,
      workspaceRoot: identity.workspaceRoot,
      startedAt: now,
      updatedAt: now,
      entries: [],
      partialReasons: [],
    }
  }

  private async load(
    sessionId: string,
    executionId: string,
  ): Promise<PrivateTurnChangeRecord | null> {
    const path = this.recordPath(sessionId, executionId)
    if (!existsSync(path)) return null
    return await readJson(path, null, {
      validate: (value) => validateRecord(value, sessionId, executionId),
    })
  }

  private async save(record: PrivateTurnChangeRecord): Promise<void> {
    await writeJsonAtomic(
      this.recordPath(record.sessionId, record.executionId),
      record,
      { mode: 0o600 },
    )
  }

  private recordPath(sessionId: string, executionId: string): string {
    validateId(sessionId, 'sessionId')
    validateId(executionId, 'executionId')
    return join(
      this.stateRoot,
      'sessions',
      sessionId,
      'runtime',
      'turn-changes',
      `${executionId}.json`,
    )
  }

  private async fileSnapshot(path: string): Promise<PrivateFileSnapshot> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile())
        return {
          state: 'unsupported',
          hash: null,
          bytes: stat.size,
          binary: false,
          contentBase64: null,
          truncated: false,
        }
      const buffer = await readFile(path)
      const binary = buffer.includes(0)
      const truncated = !binary && buffer.length > this.maxTextBytes
      return {
        state: 'file',
        hash: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
        binary,
        contentBase64: binary || truncated ? null : buffer.toString('base64'),
        truncated,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          state: 'absent',
          hash: null,
          bytes: 0,
          binary: false,
          contentBase64: '',
          truncated: false,
        }
      return {
        state: 'unsupported',
        hash: null,
        bytes: 0,
        binary: false,
        contentBase64: null,
        truncated: false,
      }
    }
  }

  private async withLock<T>(
    sessionId: string,
    executionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = `${sessionId}:${executionId}`
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const queued = previous.then(() => gate)
    this.locks.set(key, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(key) === queued) this.locks.delete(key)
    }
  }
}

function diffSnapshots(
  path: string,
  baseline: PrivateFileSnapshot,
  current: PrivateFileSnapshot,
  maxDiffCells: number,
): { file: TurnChangedFile; partial: boolean; truncated: boolean } | null {
  if (baseline.state === 'unsupported' || current.state === 'unsupported')
    return null
  const binary = baseline.binary || current.binary
  if (binary)
    return {
      file: {
        path,
        kind:
          baseline.state === 'absent'
            ? 'created'
            : current.state === 'absent'
              ? 'deleted'
              : 'modified',
        additions: null,
        deletions: null,
        binary: true,
      },
      partial: false,
      truncated: false,
    }
  const baselineText = decodeText(baseline)
  const currentText = decodeText(current)
  if (baselineText === null || currentText === null)
    return {
      file: {
        path,
        kind:
          baseline.state === 'absent'
            ? 'created'
            : current.state === 'absent'
              ? 'deleted'
              : 'modified',
        additions: null,
        deletions: null,
        binary: false,
      },
      partial: true,
      truncated: baseline.truncated || current.truncated,
    }
  const counts = lineDiffCounts(baselineText, currentText, maxDiffCells)
  return {
    file: {
      path,
      kind:
        baseline.state === 'absent'
          ? 'created'
          : current.state === 'absent'
            ? 'deleted'
            : 'modified',
      additions: counts?.additions ?? null,
      deletions: counts?.deletions ?? null,
      binary: false,
    },
    partial: counts === null,
    truncated: counts === null,
  }
}

function coalesceRenames(
  files: Array<{
    file: TurnChangedFile
    baselineHash: string | null
    currentHash: string | null
  }>,
): void {
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const deleted = files[index]!
    if (deleted.file.kind !== 'deleted' || !deleted.baselineHash) continue
    const createdIndex = files.findIndex(
      (candidate) =>
        candidate.file.kind === 'created' &&
        candidate.currentHash === deleted.baselineHash,
    )
    if (createdIndex < 0) continue
    files[createdIndex]!.file = {
      path: files[createdIndex]!.file.path,
      kind: 'renamed',
      additions: 0,
      deletions: 0,
      binary: deleted.file.binary || files[createdIndex]!.file.binary,
    }
    files.splice(index, 1)
  }
}

function lineDiffCounts(
  before: string,
  after: string,
  maxCells: number,
): { additions: number; deletions: number } | null {
  const beforeLines = textLines(before)
  const afterLines = textLines(after)
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  )
    prefix += 1
  let beforeEnd = beforeLines.length
  let afterEnd = afterLines.length
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const left = beforeLines.slice(prefix, beforeEnd)
  const right = afterLines.slice(prefix, afterEnd)
  if (left.length === 0) return { additions: right.length, deletions: 0 }
  if (right.length === 0) return { additions: 0, deletions: left.length }
  if (left.length * right.length > maxCells) return null

  let previous = new Uint32Array(right.length + 1)
  for (const leftLine of left) {
    const current = new Uint32Array(right.length + 1)
    for (let index = 1; index <= right.length; index += 1) {
      current[index] =
        leftLine === right[index - 1]
          ? previous[index - 1]! + 1
          : Math.max(previous[index]!, current[index - 1]!)
    }
    previous = current
  }
  const common = previous[right.length]!
  return {
    additions: right.length - common,
    deletions: left.length - common,
  }
}

function textLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  if (value.endsWith('\n')) lines.pop()
  return lines
}

function decodeText(snapshot: PrivateFileSnapshot): string | null {
  if (snapshot.state === 'absent') return ''
  if (snapshot.state !== 'file' || snapshot.contentBase64 === null) return null
  return Buffer.from(snapshot.contentBase64, 'base64').toString('utf8')
}

function normalizedPaths(
  workspaceRoot: string,
  paths: string[],
): Array<{ absolute: string; relative: string }> {
  const seen = new Set<string>()
  const out: Array<{ absolute: string; relative: string }> = []
  for (const raw of paths) {
    const absolute = resolve(workspaceRoot, raw)
    if (!isPathWithin(absolute, workspaceRoot))
      throw new Error('turn change path escapes workspace')
    const portable = relativePortable(workspaceRoot, absolute)
    if (!portable || portable === '.' || seen.has(portable)) continue
    seen.add(portable)
    out.push({ absolute, relative: portable })
  }
  return out
}

function validateMutationInput(input: TurnMutationInput): {
  sessionId: string
  executionId: string
  rootTurnId: string
  activeTurnId: string
  workspaceRoot: string
} {
  validateId(input.sessionId, 'sessionId')
  const activeTurnId = validatedTurnId(input.turnId)
  const executionId = validatedExecutionId(input.executionId, activeTurnId)
  const rootTurnId = validatedTurnId(input.rootTurnId ?? activeTurnId)
  const workspaceRoot = resolve(input.workspaceRoot)
  return {
    sessionId: input.sessionId,
    executionId,
    rootTurnId,
    activeTurnId,
    workspaceRoot,
  }
}

function validateRecord(
  value: unknown,
  sessionId: string,
  executionId: string,
): PrivateTurnChangeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid turn change record')
  const raw = value as Record<string, unknown>
  if (
    ![1, RECORD_VERSION].includes(Number(raw.version)) ||
    raw.sessionId !== sessionId ||
    typeof raw.workspaceRoot !== 'string' ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.partialReasons) ||
    !raw.partialReasons.every((reason) => typeof reason === 'string')
  )
    throw new Error('invalid turn change record')
  const legacy = Number(raw.version) === 1
  const storedExecutionId = String(
    legacy ? raw.turnId ?? '' : raw.executionId ?? '',
  )
  if (storedExecutionId !== executionId)
    throw new Error('invalid turn change execution identity')
  const rootTurnId = validatedTurnId(
    String(legacy ? raw.turnId ?? '' : raw.rootTurnId ?? ''),
  )
  const activeTurnId = validatedTurnId(
    String(legacy ? raw.turnId ?? '' : raw.activeTurnId ?? ''),
  )
  const workspaceRoot = resolve(raw.workspaceRoot)
  const partialReasons = [...raw.partialReasons] as string[]
  const entries = raw.entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid turn change entry')
    const entry = value as Record<string, unknown>
    if (
      typeof entry.path !== 'string' ||
      !entry.path ||
      !isPathWithin(resolve(workspaceRoot, entry.path), workspaceRoot) ||
      relativePortable(workspaceRoot, resolve(workspaceRoot, entry.path)) !==
        entry.path
    )
      throw new Error('invalid turn change entry path')
    const baseline = validateFileSnapshot(entry.baseline)
    const hasOwnedCurrent = entry.ownedCurrent !== undefined
    if (!hasOwnedCurrent) {
      addUnique(partialReasons, `legacy_unattributed_entry:${entry.path}`)
    }
    return {
      path: entry.path,
      baseline,
      ownedCurrent: hasOwnedCurrent
        ? validateFileSnapshot(entry.ownedCurrent)
        : baseline,
      attribution:
        entry.attribution === 'precise' && hasOwnedCurrent
          ? 'precise'
          : 'partial',
    } satisfies PrivateTurnChangeEntry
  })
  return {
    version: RECORD_VERSION,
    sessionId,
    executionId,
    rootTurnId,
    activeTurnId,
    workspaceRoot,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    entries,
    partialReasons,
  }
}

function validateFileSnapshot(value: unknown): PrivateFileSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid turn change file snapshot')
  const snapshot = value as Record<string, unknown>
  if (
    !['absent', 'file', 'unsupported'].includes(String(snapshot.state)) ||
    !(snapshot.hash === null || typeof snapshot.hash === 'string') ||
    !Number.isFinite(snapshot.bytes) ||
    Number(snapshot.bytes) < 0 ||
    typeof snapshot.binary !== 'boolean' ||
    !(
      snapshot.contentBase64 === null ||
      typeof snapshot.contentBase64 === 'string'
    ) ||
    typeof snapshot.truncated !== 'boolean'
  )
    throw new Error('invalid turn change file snapshot')
  return {
    state: snapshot.state as PrivateFileSnapshot['state'],
    hash: snapshot.hash as string | null,
    bytes: Math.floor(Number(snapshot.bytes)),
    binary: snapshot.binary,
    contentBase64: snapshot.contentBase64 as string | null,
    truncated: snapshot.truncated,
  }
}

function snapshotsEqual(
  left: PrivateFileSnapshot,
  right: PrivateFileSnapshot,
): boolean {
  return (
    left.state === right.state &&
    left.hash === right.hash &&
    left.bytes === right.bytes &&
    left.binary === right.binary &&
    left.truncated === right.truncated
  )
}

function addPartialReason(
  record: PrivateTurnChangeRecord,
  reason: string,
): void {
  addUnique(record.partialReasons, reason)
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function validateId(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value))
    throw new Error(`invalid turn change ${label}`)
}

function validatedTurnId(value: string): string {
  const normalized = String(value ?? '').trim()
  validateId(normalized, 'turnId')
  return normalized
}

function validatedExecutionId(
  executionId: string | undefined,
  turnId: string,
): string {
  const normalized = String(executionId ?? '').trim() || turnId
  validateId(normalized, 'executionId')
  return normalized
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback
}

function emptySnapshot(
  identity: {
    executionId: string
    rootTurnId: string
    activeTurnId: string
  },
  status: TurnChangeStatus = 'tracking',
): TurnChangeSnapshot {
  return {
    event: 'turn_change_snapshot',
    version: 2,
    turnId: identity.activeTurnId,
    executionId: identity.executionId,
    rootTurnId: identity.rootTurnId,
    activeTurnId: identity.activeTurnId,
    status,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    truncated: false,
    files: [],
  }
}
