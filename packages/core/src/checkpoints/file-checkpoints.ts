import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, lstatSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { WorkspacePolicy } from '../permissions/workspace-policy'
import { EmperorError } from '../errors'
import { readJson } from '../store/atomic-json'
import { syncDirectoryBestEffort } from '../util/fs-durability'
import { isPathWithin, relativePortable } from '../util/paths'
import {
  validateSoftGitCheckpointCapture,
  type SoftGitCaptureAdapter,
  type SoftGitCheckpointCapture,
} from './soft-git-rewind'

const INDEX_VERSION = 1
const DEFAULT_INLINE_TEXT_BYTES = 64 * 1024
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TURN_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 128 * 1024 * 1024

export type FileSnapshotState = 'absent' | 'file'
export type FileSnapshotStorage =
  'none' | 'inline_text' | 'artifact' | 'hash_only'
export type FileCheckpointChangeKind = 'create' | 'modify' | 'delete'
export type FileCheckpointStatus =
  'prepared' | 'ready' | 'no_change' | 'rewound'

export interface FileSnapshot {
  state: FileSnapshotState
  hash: string | null
  bytes: number
  mode: number | null
  storage: FileSnapshotStorage
  content?: string
  artifact?: string
}

export interface FileCheckpointChange {
  path: string
  kind: FileCheckpointChangeKind
  before: FileSnapshot
  after: FileSnapshot
}

interface PreparedPath {
  path: string
  before: FileSnapshot
}

export interface FileCheckpointRecord {
  version: 1
  id: string
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
  status: FileCheckpointStatus
  storedBytes: number
  quotaTruncated: boolean
  prepared: PreparedPath[]
  changes: FileCheckpointChange[]
  /** Optional V1 extension. Old records without this field remain valid. */
  gitCheckpoint?: SoftGitCheckpointCapture
}

export interface FileCheckpointConflict {
  path: string
  reason:
    | 'current_state_changed'
    | 'symlink_unsupported'
    | 'path_unavailable'
    | 'before_content_unavailable'
    | 'after_content_unavailable'
  expectedHash: string | null
  actualHash: string | null
}

export interface FileCheckpointPreview {
  checkpoint: FileCheckpointRecord
  canRewind: boolean
  conflicts: FileCheckpointConflict[]
}

export interface FileCheckpointDiagnostics {
  corruptIndexes: number
  lastCorruptBackup: string | null
}

export interface FileCheckpointReconcileResult {
  recovered: number
  discarded: number
  failed: number
}

export interface FileCheckpointCaptureInput {
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  workspaceRoot: string
  paths: string[]
}

export interface FileCheckpointLookupInput {
  sessionId: string
  checkpointId: string
  workspaceRoot: string
}

export class FileCheckpointError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
    this.name = 'FileCheckpointError'
  }
}

interface SnapshotDraft {
  state: FileSnapshotState
  hash: string | null
  bytes: number
  mode: number | null
  buffer: Buffer | null
}

interface ResolvedCheckpointPath {
  absolute: string
  relative: string
}

interface FileCheckpointIndex {
  version: 1
  records: FileCheckpointRecord[]
}

export class FileCheckpointService {
  readonly enabled: boolean
  private readonly stateRoot: string
  private readonly inlineTextBytes: number
  private readonly maxFileBytes: number
  private readonly maxTurnBytes: number
  private readonly maxSessionBytes: number
  private readonly gitCapture: SoftGitCaptureAdapter | null
  private readonly sessionLocks = new Map<string, Promise<void>>()
  private readonly diagnosticState: FileCheckpointDiagnostics = {
    corruptIndexes: 0,
    lastCorruptBackup: null,
  }

  constructor(opts: {
    stateRoot: string
    enabled?: boolean
    inlineTextBytes?: number
    maxFileBytes?: number
    maxTurnBytes?: number
    maxSessionBytes?: number
    gitCapture?: SoftGitCaptureAdapter | null
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.enabled = opts.enabled === true
    this.inlineTextBytes = positiveLimit(
      opts.inlineTextBytes,
      DEFAULT_INLINE_TEXT_BYTES,
    )
    this.maxFileBytes = positiveLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES)
    this.maxTurnBytes = positiveLimit(opts.maxTurnBytes, DEFAULT_MAX_TURN_BYTES)
    this.maxSessionBytes = positiveLimit(
      opts.maxSessionBytes,
      DEFAULT_MAX_SESSION_BYTES,
    )
    this.gitCapture = opts.gitCapture ?? null
  }

  diagnostics(): FileCheckpointDiagnostics {
    return { ...this.diagnosticState }
  }

  async capture<T>(
    input: FileCheckpointCaptureInput,
    effect: () => Promise<T> | T,
  ): Promise<{ value: T; checkpoint: FileCheckpointRecord | null }> {
    if (!this.enabled) return { value: await effect(), checkpoint: null }
    const identity = validateCaptureIdentity(input)
    const resolvedPaths = this.resolvePaths(input.workspaceRoot, input.paths)
    const checkpointId = newCheckpointId()
    const gitCheckpoint = this.gitCapture
      ? await this.gitCapture
          .capture({
            sessionId: identity.sessionId,
            checkpointId,
            workspaceRoot: resolve(input.workspaceRoot),
            managedPaths: resolvedPaths.map((path) => path.relative),
          })
          .catch(() => undefined)
      : undefined
    const beforeDrafts: Array<{
      path: ResolvedCheckpointPath
      draft: SnapshotDraft
    }> = []
    for (const path of resolvedPaths) {
      beforeDrafts.push({
        path,
        draft: await this.snapshotDraft(path.absolute, false),
      })
    }
    const beforeBytes = beforeDrafts.reduce(
      (sum, item) => sum + restorableBytes(item.draft),
      0,
    )
    const now = new Date().toISOString()
    let prepared!: FileCheckpointRecord
    try {
      prepared = await this.withSessionLock(identity.sessionId, async () => {
        const index = await this.loadIndex(identity.sessionId)
        this.assertQuota(index, identity.turnId, beforeBytes)
        const paths: PreparedPath[] = []
        for (const [position, item] of beforeDrafts.entries()) {
          paths.push({
            path: item.path.relative,
            before: await this.materializeSnapshot(
              identity.sessionId,
              checkpointId,
              `before-${position}`,
              item.draft,
              true,
            ),
          })
        }
        const record: FileCheckpointRecord = {
          version: 1,
          id: checkpointId,
          ...identity,
          workspaceRoot: resolve(input.workspaceRoot),
          createdAt: now,
          updatedAt: now,
          status: 'prepared',
          storedBytes: storedSnapshotBytes(paths.map((item) => item.before)),
          quotaTruncated: false,
          prepared: paths,
          changes: [],
          ...(gitCheckpoint ? { gitCheckpoint } : {}),
        }
        index.records.push(record)
        await this.saveIndex(identity.sessionId, index)
        return cloneRecord(record)
      })
    } catch (error) {
      await this.removeCheckpointArtifacts(identity.sessionId, checkpointId)
      throw error
    }

    let value!: T
    let effectError: unknown = null
    try {
      value = await effect()
    } catch (error) {
      effectError = error
    }

    const afterDrafts: SnapshotDraft[] = []
    try {
      for (const path of resolvedPaths)
        afterDrafts.push(await this.snapshotDraft(path.absolute, true))
      const checkpoint = await this.finalize(
        prepared,
        afterDrafts,
        resolvedPaths,
      )
      if (effectError !== null) throw effectError
      return { value, checkpoint }
    } catch (error) {
      if (effectError !== null) throw effectError
      throw error
    }
  }

  async list(sessionId: string): Promise<FileCheckpointRecord[]> {
    validateIdentifier(sessionId, 'session_id')
    const index = await this.loadIndex(sessionId)
    return index.records
      .filter(
        (record) => record.status === 'ready' || record.status === 'rewound',
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRecord)
  }

  async reconcilePrepared(input: {
    sessionId: string
    workspaceRoot: string
  }): Promise<FileCheckpointReconcileResult> {
    if (!this.enabled) return { recovered: 0, discarded: 0, failed: 0 }
    validateIdentifier(input.sessionId, 'session_id')
    const workspaceRoot = resolve(input.workspaceRoot)
    const records = await this.withSessionLock(input.sessionId, async () => {
      const index = await this.loadIndex(input.sessionId)
      return index.records
        .filter(
          (record) =>
            record.status === 'prepared' &&
            resolve(record.workspaceRoot) === workspaceRoot,
        )
        .map(cloneRecord)
    })
    const result: FileCheckpointReconcileResult = {
      recovered: 0,
      discarded: 0,
      failed: 0,
    }
    for (const record of records) {
      try {
        const paths = this.resolvePaths(
          workspaceRoot,
          record.prepared.map((item) => item.path),
        )
        const afterDrafts: SnapshotDraft[] = []
        for (const path of paths)
          afterDrafts.push(await this.snapshotDraft(path.absolute, true))
        const checkpoint = await this.finalize(record, afterDrafts, paths)
        if (checkpoint) result.recovered += 1
        else result.discarded += 1
      } catch {
        // Preserve the prepared record for diagnostics and a later retry. Never
        // guess at a rewind when workspace or private artifact state is unclear.
        result.failed += 1
      }
    }
    return result
  }

  async preview(
    input: FileCheckpointLookupInput,
  ): Promise<FileCheckpointPreview> {
    const record = await this.requireRecord(input)
    const conflicts: FileCheckpointConflict[] = []
    if (record.status !== 'ready') {
      conflicts.push({
        path: '',
        reason: 'current_state_changed',
        expectedHash: null,
        actualHash: null,
      })
    }
    for (const change of record.changes) {
      if (!snapshotRestorable(change.before)) {
        conflicts.push({
          path: change.path,
          reason: 'before_content_unavailable',
          expectedHash: change.after.hash,
          actualHash: null,
        })
        continue
      }
      try {
        await this.readSnapshot(record.sessionId, change.before)
      } catch {
        conflicts.push({
          path: change.path,
          reason: 'before_content_unavailable',
          expectedHash: change.after.hash,
          actualHash: null,
        })
        continue
      }
      if (!snapshotRestorable(change.after)) {
        conflicts.push({
          path: change.path,
          reason: 'after_content_unavailable',
          expectedHash: change.after.hash,
          actualHash: null,
        })
        continue
      }
      try {
        await this.readSnapshot(record.sessionId, change.after)
      } catch {
        conflicts.push({
          path: change.path,
          reason: 'after_content_unavailable',
          expectedHash: change.after.hash,
          actualHash: null,
        })
        continue
      }
      const resolvedPath = this.resolvePaths(input.workspaceRoot, [
        change.path,
      ])[0]!
      let current: SnapshotDraft
      try {
        current = await this.snapshotDraft(resolvedPath.absolute, true)
      } catch (error) {
        conflicts.push({
          path: change.path,
          reason:
            error instanceof FileCheckpointError &&
            error.code === 'symlink_unsupported'
              ? 'symlink_unsupported'
              : 'path_unavailable',
          expectedHash: change.after.hash,
          actualHash: null,
        })
        continue
      }
      if (!sameSnapshotState(current, change.after)) {
        conflicts.push({
          path: change.path,
          reason: 'current_state_changed',
          expectedHash: change.after.hash,
          actualHash: current.hash,
        })
      }
    }
    return {
      checkpoint: cloneRecord(record),
      canRewind: record.status === 'ready' && conflicts.length === 0,
      conflicts,
    }
  }

  async rewind(
    input: FileCheckpointLookupInput,
  ): Promise<FileCheckpointRecord> {
    return await this.withSessionLock(input.sessionId, async () => {
      const preview = await this.preview(input)
      if (!preview.canRewind)
        throw new FileCheckpointError(
          'rewind_conflict',
          'file checkpoint rewind conflicts with the current workspace state',
        )
      const record = preview.checkpoint
      const applied: FileCheckpointChange[] = []
      let updated!: FileCheckpointRecord
      try {
        for (const change of record.changes) {
          const path = this.resolvePaths(input.workspaceRoot, [change.path])[0]!
          const before = await this.readSnapshot(
            record.sessionId,
            change.before,
          )
          await this.applySnapshot(path.absolute, change.before, before)
          applied.push(change)
        }
        const index = await this.loadIndex(input.sessionId)
        const position = index.records.findIndex(
          (item) => item.id === record.id,
        )
        if (position < 0)
          throw new FileCheckpointError(
            'checkpoint_not_found',
            'file checkpoint disappeared before commit',
          )
        updated = {
          ...index.records[position]!,
          status: 'rewound',
          updatedAt: new Date().toISOString(),
        }
        index.records[position] = updated
        await this.saveIndex(input.sessionId, index)
      } catch {
        let rollbackFailed = false
        for (const change of applied.reverse()) {
          try {
            const path = this.resolvePaths(input.workspaceRoot, [
              change.path,
            ])[0]!
            const after = await this.readSnapshot(
              record.sessionId,
              change.after,
            )
            await this.applySnapshot(path.absolute, change.after, after)
          } catch {
            rollbackFailed = true
          }
        }
        throw new FileCheckpointError(
          rollbackFailed ? 'rewind_rollback_failed' : 'rewind_apply_failed',
          rollbackFailed
            ? 'file checkpoint rewind failed and rollback was incomplete'
            : 'file checkpoint rewind failed before completion',
        )
      }
      return cloneRecord(updated)
    })
  }

  private async finalize(
    prepared: FileCheckpointRecord,
    afterDrafts: SnapshotDraft[],
    paths: ResolvedCheckpointPath[],
  ): Promise<FileCheckpointRecord | null> {
    return await this.withSessionLock(prepared.sessionId, async () => {
      const index = await this.loadIndex(prepared.sessionId)
      const position = index.records.findIndex(
        (item) => item.id === prepared.id,
      )
      if (position < 0)
        throw new FileCheckpointError(
          'checkpoint_not_found',
          'prepared file checkpoint is missing',
        )
      const current = index.records[position]!
      if (current.status !== 'prepared') return cloneRecord(current)
      const changedPositions = afterDrafts
        .map((draft, index) =>
          sameSnapshotState(draft, current.prepared[index]!.before)
            ? -1
            : index,
        )
        .filter((index) => index >= 0)
      if (!changedPositions.length) {
        index.records.splice(position, 1)
        await this.saveIndex(prepared.sessionId, index)
        await this.removeCheckpointArtifacts(prepared.sessionId, prepared.id)
        return null
      }

      const existingWithoutCurrent = index.records.filter(
        (item) => item.id !== prepared.id,
      )
      let remainingTurn =
        this.maxTurnBytes -
        existingWithoutCurrent
          .filter((item) => item.turnId === prepared.turnId)
          .reduce((sum, item) => sum + item.storedBytes, 0) -
        current.storedBytes
      let remainingSession =
        this.maxSessionBytes -
        existingWithoutCurrent.reduce(
          (sum, item) => sum + item.storedBytes,
          0,
        ) -
        current.storedBytes
      const changes: FileCheckpointChange[] = []
      let quotaTruncated = false
      for (const index of changedPositions) {
        const draft = afterDrafts[index]!
        const wantedBytes = restorableBytes(draft)
        const retain =
          wantedBytes <= remainingTurn && wantedBytes <= remainingSession
        const after = await this.materializeSnapshot(
          prepared.sessionId,
          prepared.id,
          `after-${index}`,
          draft,
          retain,
        )
        if (retain) {
          remainingTurn -= wantedBytes
          remainingSession -= wantedBytes
        } else if (draft.state === 'file') {
          quotaTruncated = true
        }
        const before = current.prepared[index]!.before
        changes.push({
          path: paths[index]!.relative,
          kind: changeKind(before, after),
          before,
          after,
        })
      }
      const updated: FileCheckpointRecord = {
        ...current,
        status: 'ready',
        updatedAt: new Date().toISOString(),
        quotaTruncated,
        changes,
        storedBytes:
          storedSnapshotBytes(current.prepared.map((item) => item.before)) +
          storedSnapshotBytes(changes.map((item) => item.after)),
      }
      index.records[position] = updated
      await this.saveIndex(prepared.sessionId, index)
      return cloneRecord(updated)
    })
  }

  private async requireRecord(
    input: FileCheckpointLookupInput,
  ): Promise<FileCheckpointRecord> {
    validateIdentifier(input.sessionId, 'session_id')
    validateIdentifier(input.checkpointId, 'checkpoint_id')
    const index = await this.loadIndex(input.sessionId)
    const record = index.records.find((item) => item.id === input.checkpointId)
    if (!record)
      throw new FileCheckpointError(
        'checkpoint_not_found',
        'file checkpoint was not found',
      )
    if (resolve(input.workspaceRoot) !== resolve(record.workspaceRoot))
      throw new FileCheckpointError(
        'workspace_mismatch',
        'file checkpoint belongs to a different workspace',
      )
    return cloneRecord(record)
  }

  private resolvePaths(
    workspaceRoot: string,
    rawPaths: string[],
  ): ResolvedCheckpointPath[] {
    const root = resolve(workspaceRoot)
    if (!existsSync(root))
      throw new FileCheckpointError(
        'workspace_missing',
        'file checkpoint workspace does not exist',
      )
    if (!Array.isArray(rawPaths) || !rawPaths.length)
      throw new FileCheckpointError(
        'path_required',
        'file checkpoint requires at least one path',
      )
    const policy = new WorkspacePolicy({ workspaceRoot: root })
    const output: ResolvedCheckpointPath[] = []
    const seen = new Set<string>()
    for (const raw of rawPaths) {
      const decision = policy.resolvePath(String(raw ?? ''), 'write')
      if (!decision.allowed) {
        try {
          if (lstatSync(decision.resolvedPath).isSymbolicLink())
            throw new FileCheckpointError(
              'symlink_unsupported',
              'file checkpoint does not follow symbolic links',
            )
        } catch (error) {
          if (error instanceof FileCheckpointError) throw error
        }
        throw new FileCheckpointError(
          'path_outside_workspace',
          'file checkpoint path is outside the workspace',
        )
      }
      const relativePath = relativePortable(root, decision.resolvedPath)
      if (!relativePath || relative(root, decision.resolvedPath) === '')
        throw new FileCheckpointError(
          'path_is_workspace',
          'file checkpoint cannot capture the workspace directory',
        )
      if (seen.has(relativePath)) continue
      seen.add(relativePath)
      output.push({
        absolute: decision.resolvedPath,
        relative: relativePath,
      })
    }
    return output
  }

  private async snapshotDraft(
    path: string,
    allowHashOnly: boolean,
  ): Promise<SnapshotDraft> {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          state: 'absent',
          hash: null,
          bytes: 0,
          mode: null,
          buffer: null,
        }
      throw new FileCheckpointError(
        'path_unavailable',
        'file checkpoint path could not be inspected',
      )
    }
    if (info.isSymbolicLink())
      throw new FileCheckpointError(
        'symlink_unsupported',
        'file checkpoint does not follow symbolic links',
      )
    if (!info.isFile())
      throw new FileCheckpointError(
        'path_not_file',
        'file checkpoint supports regular files only',
      )
    const bytes = Number(info.size)
    if (bytes > this.maxFileBytes) {
      if (!allowHashOnly)
        throw new FileCheckpointError(
          'file_too_large',
          'file exceeds the checkpoint per-file quota',
        )
      return {
        state: 'file',
        hash: await hashFile(path),
        bytes,
        mode: info.mode & 0o777,
        buffer: null,
      }
    }
    const buffer = await readFile(path)
    return {
      state: 'file',
      hash: sha256(buffer),
      bytes: buffer.length,
      mode: info.mode & 0o777,
      buffer,
    }
  }

  private async materializeSnapshot(
    sessionId: string,
    checkpointId: string,
    label: string,
    draft: SnapshotDraft,
    retainContent: boolean,
  ): Promise<FileSnapshot> {
    if (draft.state === 'absent')
      return {
        state: 'absent',
        hash: null,
        bytes: 0,
        mode: null,
        storage: 'none',
      }
    if (!retainContent || draft.buffer === null)
      return {
        state: 'file',
        hash: draft.hash,
        bytes: draft.bytes,
        mode: draft.mode,
        storage: 'hash_only',
      }
    if (
      draft.buffer.length <= this.inlineTextBytes &&
      isRoundTripUtf8(draft.buffer)
    ) {
      return {
        state: 'file',
        hash: draft.hash,
        bytes: draft.bytes,
        mode: draft.mode,
        storage: 'inline_text',
        content: draft.buffer.toString('utf8'),
      }
    }
    const artifact = join('artifacts', checkpointId, `${safeLabel(label)}.bin`)
    const artifactPath = join(this.checkpointRoot(sessionId), artifact)
    await this.assertPrivatePathSafe(sessionId, artifactPath)
    await durableWrite(artifactPath, draft.buffer, 0o600)
    return {
      state: 'file',
      hash: draft.hash,
      bytes: draft.bytes,
      mode: draft.mode,
      storage: 'artifact',
      artifact: artifact.replace(/\\/g, '/'),
    }
  }

  private async readSnapshot(
    sessionId: string,
    snapshot: FileSnapshot,
  ): Promise<Buffer | null> {
    if (snapshot.state === 'absent') return null
    let buffer: Buffer
    if (snapshot.storage === 'inline_text') {
      buffer = Buffer.from(snapshot.content ?? '', 'utf8')
    } else if (snapshot.storage === 'artifact' && snapshot.artifact) {
      const root = this.checkpointRoot(sessionId)
      const path = resolve(root, snapshot.artifact)
      if (!isPathWithin(path, root))
        throw new FileCheckpointError(
          'artifact_invalid',
          'file checkpoint artifact escapes its private root',
        )
      await this.assertPrivatePathSafe(sessionId, path)
      const info = await lstat(path).catch(() => null)
      if (!info || !info.isFile() || info.isSymbolicLink())
        throw new FileCheckpointError(
          'artifact_invalid',
          'file checkpoint artifact is unavailable',
        )
      buffer = await readFile(path)
    } else {
      throw new FileCheckpointError(
        'snapshot_content_unavailable',
        'file checkpoint snapshot content is unavailable',
      )
    }
    if (buffer.length !== snapshot.bytes || sha256(buffer) !== snapshot.hash)
      throw new FileCheckpointError(
        'artifact_hash_mismatch',
        'file checkpoint snapshot failed integrity verification',
      )
    return buffer
  }

  private async applySnapshot(
    path: string,
    snapshot: FileSnapshot,
    content: Buffer | null,
  ): Promise<void> {
    const current = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (current?.isSymbolicLink())
      throw new FileCheckpointError(
        'symlink_unsupported',
        'file checkpoint rewind does not follow symbolic links',
      )
    if (current && !current.isFile())
      throw new FileCheckpointError(
        'path_not_file',
        'file checkpoint rewind supports regular files only',
      )
    if (snapshot.state === 'absent') {
      if (current) {
        await unlink(path)
        await syncDirectoryBestEffort(dirname(path))
      }
      return
    }
    if (!content)
      throw new FileCheckpointError(
        'snapshot_content_unavailable',
        'file checkpoint restore content is unavailable',
      )
    await durableWrite(path, content, snapshot.mode ?? 0o600)
  }

  private assertQuota(
    index: FileCheckpointIndex,
    turnId: string,
    newBytes: number,
  ): void {
    const sessionBytes = index.records.reduce(
      (sum, record) => sum + record.storedBytes,
      0,
    )
    const turnBytes = index.records
      .filter((record) => record.turnId === turnId)
      .reduce((sum, record) => sum + record.storedBytes, 0)
    if (turnBytes + newBytes > this.maxTurnBytes)
      throw new FileCheckpointError(
        'turn_quota_exceeded',
        'file checkpoint turn quota exceeded',
      )
    if (sessionBytes + newBytes > this.maxSessionBytes)
      throw new FileCheckpointError(
        'session_quota_exceeded',
        'file checkpoint session quota exceeded',
      )
  }

  private checkpointRoot(sessionId: string): string {
    validateIdentifier(sessionId, 'session_id')
    return join(this.stateRoot, 'sessions', sessionId, 'file-checkpoints')
  }

  private indexPath(sessionId: string): string {
    return join(this.checkpointRoot(sessionId), 'index.json')
  }

  private async loadIndex(sessionId: string): Promise<FileCheckpointIndex> {
    const path = this.indexPath(sessionId)
    await this.assertPrivatePathSafe(sessionId, path)
    return await readJson<FileCheckpointIndex>(
      path,
      { version: 1, records: [] },
      {
        validate: validateIndex,
        onCorrupt: (info) => {
          this.diagnosticState.corruptIndexes += 1
          this.diagnosticState.lastCorruptBackup = info.backupPath || null
        },
      },
    )
  }

  private async saveIndex(
    sessionId: string,
    index: FileCheckpointIndex,
  ): Promise<void> {
    await this.assertPrivatePathSafe(sessionId, this.indexPath(sessionId))
    await durableWrite(
      this.indexPath(sessionId),
      Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8'),
      0o600,
    )
  }

  private async removeCheckpointArtifacts(
    sessionId: string,
    checkpointId: string,
  ): Promise<void> {
    validateIdentifier(checkpointId, 'checkpoint_id')
    const path = join(this.checkpointRoot(sessionId), 'artifacts', checkpointId)
    await this.assertPrivatePathSafe(sessionId, path)
    await rm(path, {
      recursive: true,
      force: true,
    }).catch(() => {})
  }

  private async assertPrivatePathSafe(
    sessionId: string,
    targetPath: string,
  ): Promise<void> {
    validateIdentifier(sessionId, 'session_id')
    const sessionsRoot = join(this.stateRoot, 'sessions')
    const sessionRoot = join(sessionsRoot, sessionId)
    const checkpointRoot = this.checkpointRoot(sessionId)
    const target = resolve(targetPath)
    if (!isPathWithin(target, checkpointRoot))
      throw new FileCheckpointError(
        'checkpoint_storage_invalid',
        'file checkpoint storage path escapes its private root',
      )
    const candidates = [sessionsRoot, sessionRoot, checkpointRoot]
    const tail = relative(checkpointRoot, target)
    if (tail) {
      let current = checkpointRoot
      for (const segment of tail.split(/[\\/]/)) {
        current = join(current, segment)
        candidates.push(current)
      }
    }
    for (const candidate of candidates) {
      const info = await lstat(candidate).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (info?.isSymbolicLink())
        throw new FileCheckpointError(
          'checkpoint_storage_symlink',
          'file checkpoint private storage cannot contain symbolic links',
        )
    }
  }

  private async withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    validateIdentifier(sessionId, 'session_id')
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const queued = prior.catch(() => {}).then(() => gate)
    this.sessionLocks.set(sessionId, queued)
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.sessionLocks.get(sessionId) === queued)
        this.sessionLocks.delete(sessionId)
    }
  }
}

function validateCaptureIdentity(input: FileCheckpointCaptureInput): {
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
} {
  return {
    sessionId: validateIdentifier(input.sessionId, 'session_id'),
    turnId: validateIdentifier(input.turnId, 'turn_id'),
    toolCallId: validateIdentifier(input.toolCallId, 'tool_call_id'),
    toolName: validateIdentifier(input.toolName, 'tool_name'),
  }
}

function validateIdentifier(value: string, field: string): string {
  const text = String(value ?? '').trim()
  if (
    !text ||
    text.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) ||
    text.includes('..')
  )
    throw new FileCheckpointError(
      'invalid_identifier',
      `invalid file checkpoint ${field}`,
    )
  return text
}

function validateIndex(value: unknown): FileCheckpointIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('checkpoint index must be an object')
  const input = value as Record<string, unknown>
  if (input.version !== INDEX_VERSION || !Array.isArray(input.records))
    throw new Error('unsupported checkpoint index')
  const records = input.records.map(validateRecord)
  return { version: 1, records }
}

function validateRecord(value: unknown): FileCheckpointRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('checkpoint record must be an object')
  const record = value as FileCheckpointRecord
  if (
    record.version !== 1 ||
    !['prepared', 'ready', 'no_change', 'rewound'].includes(record.status) ||
    !Array.isArray(record.prepared) ||
    !Array.isArray(record.changes) ||
    !Number.isFinite(record.storedBytes) ||
    typeof record.workspaceRoot !== 'string' ||
    !record.workspaceRoot
  )
    throw new Error('invalid checkpoint record')
  validateIdentifier(record.id, 'checkpoint_id')
  validateIdentifier(record.sessionId, 'session_id')
  validateIdentifier(record.turnId, 'turn_id')
  validateIdentifier(record.toolCallId, 'tool_call_id')
  validateIdentifier(record.toolName, 'tool_name')
  for (const item of record.prepared) {
    validateRelativePath(item.path)
    validateSnapshot(item.before)
  }
  for (const change of record.changes) {
    validateRelativePath(change.path)
    if (!['create', 'modify', 'delete'].includes(change.kind))
      throw new Error('invalid checkpoint change')
    validateSnapshot(change.before)
    validateSnapshot(change.after)
  }
  if (record.gitCheckpoint !== undefined)
    validateSoftGitCheckpointCapture(record.gitCheckpoint)
  return cloneRecord(record)
}

function validateRelativePath(value: string): void {
  const path = String(value ?? '')
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').includes('..')
  )
    throw new Error('invalid checkpoint path')
}

function validateSnapshot(value: FileSnapshot): void {
  if (
    !value ||
    !['absent', 'file'].includes(value.state) ||
    !['none', 'inline_text', 'artifact', 'hash_only'].includes(value.storage) ||
    !Number.isFinite(value.bytes) ||
    value.bytes < 0
  )
    throw new Error('invalid file snapshot')
  if (value.state === 'file' && !/^[a-f0-9]{64}$/.test(value.hash ?? ''))
    throw new Error('invalid file snapshot hash')
  if (value.storage === 'artifact') {
    const artifact = String(value.artifact ?? '')
    if (
      !artifact.startsWith('artifacts/') ||
      artifact.includes('\\') ||
      artifact.startsWith('/') ||
      artifact.split('/').includes('..')
    )
      throw new Error('invalid file snapshot artifact')
  }
}

function cloneRecord(record: FileCheckpointRecord): FileCheckpointRecord {
  return JSON.parse(JSON.stringify(record)) as FileCheckpointRecord
}

function sameSnapshotState(
  current: SnapshotDraft,
  expected: FileSnapshot,
): boolean {
  return current.state === expected.state && current.hash === expected.hash
}

function snapshotRestorable(snapshot: FileSnapshot): boolean {
  return (
    snapshot.state === 'absent' ||
    snapshot.storage === 'inline_text' ||
    snapshot.storage === 'artifact'
  )
}

function changeKind(
  before: FileSnapshot,
  after: FileSnapshot,
): FileCheckpointChangeKind {
  if (before.state === 'absent') return 'create'
  if (after.state === 'absent') return 'delete'
  return 'modify'
}

function storedSnapshotBytes(snapshots: FileSnapshot[]): number {
  return snapshots.reduce(
    (sum, snapshot) =>
      sum + (snapshotRestorable(snapshot) ? snapshot.bytes : 0),
    0,
  )
}

function restorableBytes(draft: SnapshotDraft): number {
  return draft.state === 'file' && draft.buffer ? draft.buffer.length : 0
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function newCheckpointId(): string {
  return `fcp_${randomBytes(12).toString('hex')}`
}

function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function isRoundTripUtf8(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer)
}

async function durableWrite(
  path: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = join(
    parent,
    `.${path.split(/[\\/]/).pop()}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`,
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
    await syncDirectoryBestEffort(parent)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}
