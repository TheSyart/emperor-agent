import { resolve } from 'node:path'
import {
  FileCheckpointError,
  FileCheckpointService,
  type FileCheckpointConflict,
  type FileCheckpointReconcileResult,
  type FileCheckpointRecord,
  type FileSnapshot,
} from '../../checkpoints/file-checkpoints'
import type { SessionEntry } from '../../sessions/store'
import {
  SoftGitRewindError,
  type SoftGitCheckpointCapture,
  type SoftGitRewindDiagnostics,
  type SoftGitDirtyStrategy,
  type SoftGitRewindPreview,
  type SoftGitRewindReconcileResult,
  type SoftGitRewindReceipt,
  type SoftGitRewindService,
} from '../../checkpoints/soft-git-rewind'

export interface CoreFileCheckpointServiceDeps {
  checkpoints: FileCheckpointService
  softGitRewind: SoftGitRewindService
  applicationRoot: string
  activeSessionId: () => string | null
  requireReadableSession: (sessionId: string, operation: string) => SessionEntry
  assertMutation?: (area: string, action: string) => void
}

export interface CoreFileCheckpointListPayload {
  enabled: boolean
  sessionId: string
  checkpoints: CoreFileCheckpointRecord[]
  reconciliation: FileCheckpointReconcileResult
  gitRewindMode: SoftGitRewindService['requestedMode']
  gitReconciliation: SoftGitRewindReconcileResult
  gitDiagnostics: SoftGitRewindDiagnostics
}

export interface CoreFileCheckpointSnapshot {
  state: FileSnapshot['state']
  hash: string | null
  bytes: number
  storage: FileSnapshot['storage']
}

export interface CoreFileCheckpointRecord {
  version: 1
  id: string
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  createdAt: string
  updatedAt: string
  status: FileCheckpointRecord['status']
  storedBytes: number
  quotaTruncated: boolean
  changes: Array<{
    path: string
    kind: FileCheckpointRecord['changes'][number]['kind']
    before: CoreFileCheckpointSnapshot
    after: CoreFileCheckpointSnapshot
  }>
  gitCheckpoint: CoreSoftGitCheckpointCapture | null
}

export interface CoreSoftGitCheckpointCapture {
  version: 1
  status: SoftGitCheckpointCapture['status']
  reason: SoftGitCheckpointCapture['reason']
  head: string | null
  branch: string | null
  indexFingerprint: string | null
  stagedPaths: string[]
  capturedAt: string
  repository: {
    rootDigest: string
    gitDirDigest: string
    commonDirDigest: string
  } | null
}

export interface CoreFileCheckpointPreview {
  checkpoint: CoreFileCheckpointRecord
  canRewind: boolean
  conflicts: FileCheckpointConflict[]
  git: SoftGitRewindPreview | null
}

export interface CoreFileCheckpointGitRewindResult {
  checkpoint: CoreFileCheckpointRecord
  git: SoftGitRewindReceipt
}

export class CoreFileCheckpointService {
  private readonly deps: CoreFileCheckpointServiceDeps

  constructor(deps: CoreFileCheckpointServiceDeps) {
    this.deps = deps
  }

  async list(
    input: { sessionId?: string | null } = {},
  ): Promise<CoreFileCheckpointListPayload> {
    const session = this.session(
      input.sessionId ?? this.deps.activeSessionId(),
      'fileCheckpoints.list',
    )
    const reconciliation = this.deps.checkpoints.enabled
      ? await this.deps.checkpoints.reconcilePrepared({
          sessionId: session.id,
          workspaceRoot: this.workspaceRoot(session),
        })
      : { recovered: 0, discarded: 0, failed: 0 }
    const checkpoints = this.deps.checkpoints.enabled
      ? await this.deps.checkpoints.list(session.id)
      : []
    const gitReconciliation =
      this.deps.softGitRewind.requestedMode !== 'off'
        ? await this.deps.softGitRewind.reconcile({
            sessionId: session.id,
            workspaceRoot: this.workspaceRoot(session),
            checkpointStatuses: Object.fromEntries(
              checkpoints.map((checkpoint) => [
                checkpoint.id,
                checkpoint.status,
              ]),
            ),
          })
        : { completed: 0, interrupted: 0, unchanged: 0 }
    return {
      enabled: this.deps.checkpoints.enabled,
      sessionId: session.id,
      reconciliation,
      gitRewindMode: this.deps.softGitRewind.requestedMode,
      gitReconciliation,
      gitDiagnostics: this.deps.softGitRewind.diagnostics(),
      checkpoints: checkpoints.map(toPublicRecord),
    }
  }

  async preview(input: {
    sessionId: string
    checkpointId: string
  }): Promise<CoreFileCheckpointPreview> {
    this.assertEnabled()
    const session = this.session(input.sessionId, 'fileCheckpoints.preview')
    const preview = await this.deps.checkpoints.preview({
      sessionId: session.id,
      checkpointId: input.checkpointId,
      workspaceRoot: this.workspaceRoot(session),
    })
    const git = preview.checkpoint.gitCheckpoint
      ? await this.deps.softGitRewind.preview({
          sessionId: session.id,
          checkpointId: input.checkpointId,
          workspaceRoot: this.workspaceRoot(session),
          managedPaths: preview.checkpoint.changes.map((change) => change.path),
          capture: preview.checkpoint.gitCheckpoint,
          fileCanRewind: preview.canRewind,
        })
      : null
    return {
      ...preview,
      checkpoint: toPublicRecord(preview.checkpoint),
      git,
    }
  }

  async rewind(input: {
    sessionId: string
    checkpointId: string
    confirmed: boolean
  }): Promise<CoreFileCheckpointRecord> {
    if (input.confirmed !== true)
      throw new FileCheckpointError(
        'rewind_confirmation_required',
        'file checkpoint rewind confirmation is required',
      )
    this.assertEnabled()
    const session = this.session(input.sessionId, 'fileCheckpoints.rewind')
    this.deps.assertMutation?.('fileCheckpoints', 'rewind')
    return toPublicRecord(
      await this.deps.checkpoints.rewind({
        sessionId: session.id,
        checkpointId: input.checkpointId,
        workspaceRoot: this.workspaceRoot(session),
      }),
    )
  }

  async rewindGit(input: {
    sessionId: string
    checkpointId: string
    confirmed: boolean
    confirmedGitRisk: boolean
    previewRevision: string
    dirtyStrategy: SoftGitDirtyStrategy
  }): Promise<CoreFileCheckpointGitRewindResult> {
    if (input.confirmed !== true || input.confirmedGitRisk !== true)
      throw new SoftGitRewindError(
        'git_rewind_confirmation_required',
        'soft Git rewind requires explicit confirmation',
      )
    this.assertEnabled()
    const session = this.session(input.sessionId, 'fileCheckpoints.rewindGit')
    this.deps.assertMutation?.('fileCheckpoints', 'rewindGit')
    const workspaceRoot = this.workspaceRoot(session)
    const filePreview = await this.deps.checkpoints.preview({
      sessionId: session.id,
      checkpointId: input.checkpointId,
      workspaceRoot,
    })
    if (!filePreview.canRewind)
      throw new FileCheckpointError(
        'rewind_conflict',
        'file checkpoint conflicts must be resolved before soft Git rewind',
      )
    const capture = filePreview.checkpoint.gitCheckpoint
    if (!capture)
      throw new SoftGitRewindError(
        'capture_unavailable',
        'this file checkpoint has no soft Git checkpoint',
      )
    let rewound: FileCheckpointRecord | null = null
    const git = await this.deps.softGitRewind.rewind({
      sessionId: session.id,
      checkpointId: input.checkpointId,
      workspaceRoot,
      managedPaths: filePreview.checkpoint.changes.map((change) => change.path),
      capture,
      previewRevision: String(input.previewRevision ?? ''),
      dirtyStrategy: input.dirtyStrategy,
      confirmed: input.confirmed,
      confirmedGitRisk: input.confirmedGitRisk,
      applyFiles: async () => {
        rewound = await this.deps.checkpoints.rewind({
          sessionId: session.id,
          checkpointId: input.checkpointId,
          workspaceRoot,
        })
      },
    })
    if (!rewound)
      throw new SoftGitRewindError(
        'file_rewind_missing',
        'file checkpoint rewind did not return a committed record',
      )
    return { checkpoint: toPublicRecord(rewound), git }
  }

  private session(
    sessionId: string | null | undefined,
    operation: string,
  ): SessionEntry {
    return this.deps.requireReadableSession(
      String(sessionId ?? '').trim(),
      operation,
    )
  }

  private workspaceRoot(session: SessionEntry): string {
    return resolve(
      session.mode === 'build' && session.project_path
        ? session.project_path
        : this.deps.applicationRoot,
    )
  }

  private assertEnabled(): void {
    if (!this.deps.checkpoints.enabled)
      throw new FileCheckpointError(
        'file_checkpoints_disabled',
        'file checkpoints are disabled',
      )
  }
}

function toPublicRecord(
  record: FileCheckpointRecord,
): CoreFileCheckpointRecord {
  return {
    version: 1,
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    storedBytes: record.storedBytes,
    quotaTruncated: record.quotaTruncated,
    changes: record.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      before: toPublicSnapshot(change.before),
      after: toPublicSnapshot(change.after),
    })),
    gitCheckpoint: record.gitCheckpoint
      ? toPublicGitCapture(record.gitCheckpoint)
      : null,
  }
}

function toPublicGitCapture(
  capture: SoftGitCheckpointCapture,
): CoreSoftGitCheckpointCapture {
  return {
    version: 1,
    status: capture.status,
    reason: capture.reason,
    head: capture.head,
    branch: capture.branch,
    indexFingerprint: capture.indexFingerprint,
    stagedPaths: [...capture.stagedPaths],
    capturedAt: capture.capturedAt,
    repository: capture.repository
      ? {
          rootDigest: capture.repository.rootDigest,
          gitDirDigest: capture.repository.gitDirDigest,
          commonDirDigest: capture.repository.commonDirDigest,
        }
      : null,
  }
}

function toPublicSnapshot(snapshot: FileSnapshot): CoreFileCheckpointSnapshot {
  return {
    state: snapshot.state,
    hash: snapshot.hash,
    bytes: snapshot.bytes,
    storage: snapshot.storage,
  }
}
