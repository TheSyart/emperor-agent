import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractProjectMemoryBlock, replaceProjectMemoryBlock } from '../projects/state-store'
import { CompactionCursorStore, CompactionLedger } from './compaction-ledger'
import {
  applyMemoryPatch,
  memoryContentHash,
  type MemoryPatch,
  type MemoryPatchApplyOptions,
  type MemoryPatchApplyResult,
} from './patch'
import { MemoryVersionStore, type MemoryVersionTarget } from './versions'
import type { ActiveMemoryBinding, CompactionPatchBundle, CompactionRunRecord } from './compaction-models'

export interface CompactionPatchCommitterOptions {
  root: string
  memoryDir: string
  userFile: string
  versions?: MemoryVersionStore
  cursorStore?: CompactionCursorStore
  ledger?: CompactionLedger
  writeText?: (path: string, content: string) => void
}

export interface CommitPatchBundleOptions extends MemoryPatchApplyOptions {
  trigger: CompactionRunRecord['trigger']
  activeMemoryBinding: ActiveMemoryBinding
  input: CompactionRunRecord['input']
}

export interface CommitPatchBundleResult {
  ok: boolean
  applied: Array<{ scope: MemoryPatch['target']; path: string; operationCount: number }>
  errors: string[]
}

interface PatchTarget {
  patch: MemoryPatch
  path: string
  versionTarget: MemoryVersionTarget
  current: string
  fullCurrent: string
}

interface PreparedPatchTarget extends PatchTarget {
  result: MemoryPatchApplyResult
  nextContent: string
}

export class CompactionPatchCommitter {
  readonly root: string
  readonly memoryDir: string
  readonly userFile: string
  readonly versions: MemoryVersionStore
  readonly cursorStore: CompactionCursorStore
  readonly ledger: CompactionLedger
  private readonly writeText: (path: string, content: string) => void

  constructor(opts: CompactionPatchCommitterOptions) {
    this.root = resolve(opts.root)
    this.memoryDir = resolve(opts.memoryDir)
    this.userFile = resolve(opts.userFile)
    this.versions = opts.versions ?? new MemoryVersionStore(this.root, this.memoryDir, this.userFile)
    this.cursorStore = opts.cursorStore ?? new CompactionCursorStore(this.root)
    this.ledger = opts.ledger ?? new CompactionLedger(this.root)
    this.writeText = opts.writeText ?? MemoryVersionStore.atomicWriteText
  }

  commitBundle(bundle: CompactionPatchBundle, opts: CommitPatchBundleOptions): CommitPatchBundleResult {
    const previousCursor = this.cursorStore.readOrInit(bundle.sessionId)
    const started = this.ledger.recordStarted(runRecord(bundle, opts))
    this.cursorStore.markCompacting(bundle.sessionId, {
      lastHistorySeq: bundle.range.toSeq,
      compactionId: bundle.compactionId,
    })

    const targets = this.targetsFor(bundle)
    const validationErrors = this.validateTargets(targets, bundle, opts)
    if (validationErrors.length) {
      this.recordFailure(started, previousCursor, {
        code: 'validation_failed',
        message: 'compaction patch bundle validation failed',
        validationErrors,
      })
      return { ok: false, applied: [], errors: validationErrors }
    }

    try {
      const applied: Array<{ scope: MemoryPatch['target']; path: string; operationCount: number }> = []
      const targetVersions: NonNullable<CompactionRunRecord['output']>['targetVersions'] = []
      const prepared = targets.map((target) => this.prepareTargetPatch(target, bundle, opts))
      for (const target of prepared) {
        this.versions.snapshotPath(target.path, {
          target: target.versionTarget,
          reason: `memory_patch:${target.patch.rationale || 'patch'}`,
        })
      }
      this.writePreparedTargets(prepared)
      for (const target of prepared) {
        applied.push({ scope: target.patch.target, path: target.path, operationCount: target.result.appliedOperations })
        targetVersions.push({
          scope: target.patch.target,
          beforeVersion: target.patch.baseVersion,
          beforeHash: memoryContentHash(target.current),
          afterVersion: target.patch.baseVersion + 1,
          afterHash: memoryContentHash(target.result.content),
          operationCount: target.result.appliedOperations,
        })
      }

      try {
        this.ledger.recordApplied({
          ...started,
          output: {
            decisions: bundle.decisions,
            discarded: bundle.discarded,
            targetVersions,
          },
        })
        this.cursorStore.advance(bundle.sessionId, {
          compactedUntilSeq: bundle.range.toSeq,
          compactionId: bundle.compactionId,
          lastHistorySeq: bundle.range.toSeq,
        })
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error)
        try {
          this.rollbackPreparedTargets(prepared)
        } catch (rollbackError) {
          message = `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        }
        this.recordFailure(started, previousCursor, {
          code: 'apply_failed',
          message,
        })
        return { ok: false, applied: [], errors: [message] }
      }
      return { ok: true, applied, errors: [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordFailure(started, previousCursor, {
        code: 'apply_failed',
        message,
      })
      return { ok: false, applied: [], errors: [message] }
    }
  }

  private validateTargets(targets: PatchTarget[], bundle: CompactionPatchBundle, opts: MemoryPatchApplyOptions): string[] {
    const errors: string[] = []
    for (const target of targets) {
      const result = applyMemoryPatch(target.patch, target.current, {
        mode: bundle.mode,
        allowBuildGlobalWrite: opts.allowBuildGlobalWrite,
        explicitReplace: opts.explicitReplace,
        currentVersion: this.currentVersionForTarget(target),
      })
      errors.push(...result.errors)
    }
    return [...new Set(errors)]
  }

  private targetsFor(bundle: CompactionPatchBundle): PatchTarget[] {
    return flattenPatches(bundle).map((patch) => {
      const resolved = this.resolveTarget(patch.target)
      const fullCurrent = existsSync(resolved.path) ? readFileSync(resolved.path, 'utf8') : ''
      const current = patch.target.kind === 'project'
        ? extractProjectMemoryBlock(fullCurrent) ?? fullCurrent
        : fullCurrent
      return { patch, ...resolved, current, fullCurrent }
    })
  }

  private prepareTargetPatch(target: PatchTarget, bundle: CompactionPatchBundle, opts: MemoryPatchApplyOptions): PreparedPatchTarget {
    const result = applyMemoryPatch(target.patch, target.current, {
      mode: bundle.mode,
      allowBuildGlobalWrite: opts.allowBuildGlobalWrite,
      explicitReplace: opts.explicitReplace,
      currentVersion: this.currentVersionForTarget(target),
    })
    if (!result.ok) throw new Error(result.errors.join(', ') || 'patch apply failed')
    const nextContent = target.patch.target.kind === 'project'
      ? replaceProjectMemoryBlock(target.fullCurrent, result.content)
      : result.content
    return { ...target, result, nextContent: nextContent.trimEnd() + '\n' }
  }

  private writePreparedTargets(targets: PreparedPatchTarget[]): void {
    const written: PreparedPatchTarget[] = []
    try {
      for (const target of targets) {
        this.writeText(target.path, target.nextContent)
        written.push(target)
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const target of written.reverse()) {
        try {
          this.writeText(target.path, target.fullCurrent)
        } catch (rollbackError) {
          rollbackErrors.push(`${target.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      if (rollbackErrors.length) {
        throw new Error(`${message}; rollback failed: ${rollbackErrors.join('; ')}`)
      }
      throw error
    }
  }

  private rollbackPreparedTargets(targets: PreparedPatchTarget[]): void {
    const rollbackErrors: string[] = []
    for (const target of [...targets].reverse()) {
      try {
        this.writeText(target.path, target.fullCurrent)
      } catch (error) {
        rollbackErrors.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (rollbackErrors.length) throw new Error(rollbackErrors.join('; '))
  }

  private recordFailure(started: CompactionRunRecord, previousCursor: ReturnType<CompactionCursorStore['readOrInit']>, error: NonNullable<CompactionRunRecord['error']>): void {
    try {
      this.ledger.recordFailed(started, error)
    } finally {
      this.cursorStore.restore(previousCursor)
    }
  }

  private resolveTarget(scope: MemoryPatch['target']): { path: string; versionTarget: MemoryVersionTarget } {
    if (scope.kind === 'user_profile') return { path: this.userFile, versionTarget: 'user' }
    if (scope.kind === 'global') return { path: join(this.memoryDir, 'MEMORY.local.md'), versionTarget: 'memory' }
    if (scope.kind === 'episode') return { path: join(this.memoryDir, `${scope.date}.md`), versionTarget: 'episode' }
    if (scope.kind === 'project') return { path: join(this.root, 'projects', scope.projectId, 'AGENTS.local.md'), versionTarget: 'project' }
    throw new Error(`unsupported compaction patch scope: ${scope.kind}`)
  }

  private currentVersionForTarget(target: PatchTarget): number {
    return this.versions.nextVersionForPath(target.path, { target: target.versionTarget })
  }
}

function flattenPatches(bundle: CompactionPatchBundle): MemoryPatch[] {
  return [
    bundle.patches.episodePatch,
    bundle.patches.userProfilePatch,
    bundle.patches.globalMemoryPatch,
    bundle.patches.projectMemoryPatch,
  ].filter((patch): patch is MemoryPatch => Boolean(patch))
}

function runRecord(bundle: CompactionPatchBundle, opts: CommitPatchBundleOptions): CompactionRunRecord {
  return {
    compactionId: bundle.compactionId,
    sessionId: bundle.sessionId,
    mode: bundle.mode,
    ...(bundle.projectId ? { projectId: bundle.projectId } : {}),
    trigger: opts.trigger,
    range: bundle.range,
    status: 'started',
    activeMemoryBinding: opts.activeMemoryBinding,
    input: opts.input,
  }
}
