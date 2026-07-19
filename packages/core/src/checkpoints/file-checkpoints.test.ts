import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileCheckpointError, FileCheckpointService } from './file-checkpoints'

function roots(label: string): { stateRoot: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), `emperor-checkpoint-${label}-`))
  const stateRoot = join(root, 'state')
  const workspace = join(root, 'workspace')
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  return { stateRoot, workspace }
}

function captureInput(
  workspaceRoot: string,
  overrides: Partial<{
    sessionId: string
    turnId: string
    toolCallId: string
    toolName: string
    paths: string[]
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? 'session-one',
    turnId: overrides.turnId ?? 'turn-one',
    toolCallId: overrides.toolCallId ?? 'call-one',
    toolName: overrides.toolName ?? 'write_file',
    workspaceRoot,
    paths: overrides.paths ?? ['file.txt'],
  }
}

describe('FileCheckpointService capture and rewind', () => {
  it('captures optional Git state before the file effect and persists it without weakening file rewind', async () => {
    const { stateRoot, workspace } = roots('git-capture')
    let effectStarted = false
    const captureGit = vi.fn(async () => {
      expect(effectStarted).toBe(false)
      return {
        version: 1 as const,
        status: 'captured' as const,
        reason: 'ready' as const,
        repository: {
          root: workspace,
          gitDir: join(workspace, '.git'),
          commonDir: join(workspace, '.git'),
          rootDigest: 'a'.repeat(64),
          gitDirDigest: 'b'.repeat(64),
          commonDirDigest: 'b'.repeat(64),
        },
        head: 'c'.repeat(40),
        branch: 'refs/heads/main',
        indexFingerprint: 'd'.repeat(64),
        stagedPaths: ['already-staged.txt'],
        capturedAt: '2026-07-19T00:00:00.000Z',
      }
    })
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      gitCapture: { capture: captureGit },
    })
    const result = await service.capture(captureInput(workspace), async () => {
      effectStarted = true
      writeFileSync(join(workspace, 'file.txt'), 'after')
    })

    expect(captureGit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-one',
        checkpointId: result.checkpoint!.id,
        workspaceRoot: workspace,
        managedPaths: ['file.txt'],
      }),
    )
    expect(result.checkpoint?.gitCheckpoint).toMatchObject({
      status: 'captured',
      head: 'c'.repeat(40),
      stagedPaths: ['already-staged.txt'],
    })
    const restarted = new FileCheckpointService({ stateRoot, enabled: true })
    expect((await restarted.list('session-one'))[0]?.gitCheckpoint).toEqual(
      result.checkpoint?.gitCheckpoint,
    )
    await restarted.rewind({
      sessionId: 'session-one',
      checkpointId: result.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(existsSync(join(workspace, 'file.txt'))).toBe(false)
  })

  it('keeps file checkpoint capture available when optional Git capture fails', async () => {
    const { stateRoot, workspace } = roots('git-capture-failure')
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      gitCapture: {
        capture: async () => {
          throw new Error('Git unavailable')
        },
      },
    })
    const result = await service.capture(captureInput(workspace), async () =>
      writeFileSync(join(workspace, 'file.txt'), 'after'),
    )
    expect(result.checkpoint).toMatchObject({
      status: 'ready',
      changes: [{ path: 'file.txt', kind: 'create' }],
    })
    expect(result.checkpoint).not.toHaveProperty('gitCheckpoint')
  })

  it('rewinds create, modify, delete, and rename with exact bytes', async () => {
    const { stateRoot, workspace } = roots('matrix')
    const service = new FileCheckpointService({ stateRoot, enabled: true })

    const created = await service.capture(
      captureInput(workspace, {
        toolCallId: 'create',
        paths: ['created.txt'],
      }),
      async () => writeFileSync(join(workspace, 'created.txt'), 'created'),
    )
    expect(created.checkpoint?.changes[0]).toMatchObject({
      path: 'created.txt',
      kind: 'create',
      before: { state: 'absent' },
      after: { state: 'file' },
    })
    await service.rewind({
      sessionId: 'session-one',
      checkpointId: created.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(existsSync(join(workspace, 'created.txt'))).toBe(false)

    writeFileSync(join(workspace, 'modified.txt'), 'before-modify')
    const modified = await service.capture(
      captureInput(workspace, {
        turnId: 'turn-two',
        toolCallId: 'modify',
        paths: ['modified.txt'],
      }),
      async () => writeFileSync(join(workspace, 'modified.txt'), 'after'),
    )
    expect(modified.checkpoint?.changes[0]?.kind).toBe('modify')
    await service.rewind({
      sessionId: 'session-one',
      checkpointId: modified.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(readFileSync(join(workspace, 'modified.txt'), 'utf8')).toBe(
      'before-modify',
    )

    writeFileSync(join(workspace, 'deleted.txt'), 'restore-delete')
    const deleted = await service.capture(
      captureInput(workspace, {
        turnId: 'turn-three',
        toolCallId: 'delete',
        toolName: 'delete_file',
        paths: ['deleted.txt'],
      }),
      async () => unlinkSync(join(workspace, 'deleted.txt')),
    )
    expect(deleted.checkpoint?.changes[0]?.kind).toBe('delete')
    await service.rewind({
      sessionId: 'session-one',
      checkpointId: deleted.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(readFileSync(join(workspace, 'deleted.txt'), 'utf8')).toBe(
      'restore-delete',
    )

    writeFileSync(join(workspace, 'old-name.txt'), 'rename-bytes')
    const renamed = await service.capture(
      captureInput(workspace, {
        turnId: 'turn-four',
        toolCallId: 'rename',
        toolName: 'rename_file',
        paths: ['old-name.txt', 'new-name.txt'],
      }),
      async () =>
        renameSync(
          join(workspace, 'old-name.txt'),
          join(workspace, 'new-name.txt'),
        ),
    )
    expect(renamed.checkpoint?.changes.map((change) => change.kind)).toEqual([
      'delete',
      'create',
    ])
    await service.rewind({
      sessionId: 'session-one',
      checkpointId: renamed.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(readFileSync(join(workspace, 'old-name.txt'), 'utf8')).toBe(
      'rename-bytes',
    )
    expect(existsSync(join(workspace, 'new-name.txt'))).toBe(false)
  })

  it('stores binary and large snapshots as private artifacts and restores exact hashes', async () => {
    const { stateRoot, workspace } = roots('artifact')
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      inlineTextBytes: 32,
      maxFileBytes: 512 * 1024,
    })
    const binaryBefore = Buffer.from([0, 1, 2, 3, 255, 10])
    const largeBefore = Buffer.alloc(128 * 1024, 0x61)
    writeFileSync(join(workspace, 'binary.dat'), binaryBefore)
    writeFileSync(join(workspace, 'large.txt'), largeBefore)

    const captured = await service.capture(
      captureInput(workspace, {
        paths: ['binary.dat', 'large.txt'],
      }),
      async () => {
        writeFileSync(join(workspace, 'binary.dat'), Buffer.from([9, 8, 7]))
        writeFileSync(
          join(workspace, 'large.txt'),
          Buffer.alloc(96 * 1024, 0x62),
        )
      },
    )

    expect(
      captured.checkpoint?.changes.map((change) => change.before.storage),
    ).toEqual(['artifact', 'artifact'])
    await service.rewind({
      sessionId: 'session-one',
      checkpointId: captured.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(readFileSync(join(workspace, 'binary.dat'))).toEqual(binaryBefore)
    expect(readFileSync(join(workspace, 'large.txt'))).toEqual(largeBefore)
  })

  it('vetoes the whole rewind when any file changed externally', async () => {
    const { stateRoot, workspace } = roots('conflict')
    const service = new FileCheckpointService({ stateRoot, enabled: true })
    writeFileSync(join(workspace, 'a.txt'), 'a-before')
    writeFileSync(join(workspace, 'b.txt'), 'b-before')
    const captured = await service.capture(
      captureInput(workspace, { paths: ['a.txt', 'b.txt'] }),
      async () => {
        writeFileSync(join(workspace, 'a.txt'), 'a-after')
        writeFileSync(join(workspace, 'b.txt'), 'b-after')
      },
    )
    writeFileSync(join(workspace, 'b.txt'), 'external-change')

    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: captured.checkpoint!.id,
      workspaceRoot: workspace,
    })
    expect(preview).toMatchObject({
      canRewind: false,
      conflicts: [{ path: 'b.txt', reason: 'current_state_changed' }],
    })
    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: captured.checkpoint!.id,
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: 'rewind_conflict' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a-after')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe(
      'external-change',
    )
  })

  it('rolls workspace files back to after when the rewind index commit fails', async () => {
    const { stateRoot, workspace } = roots('rewind-commit-failure')
    const service = new FileCheckpointService({ stateRoot, enabled: true })
    const target = join(workspace, 'file.txt')
    writeFileSync(target, 'before')
    const captured = await service.capture(captureInput(workspace), async () =>
      writeFileSync(target, 'after'),
    )
    const internals = service as unknown as {
      saveIndex: (...args: unknown[]) => Promise<void>
    }
    internals.saveIndex = vi.fn(async () => {
      throw new Error('injected index commit failure')
    })

    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: captured.checkpoint!.id,
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: 'rewind_apply_failed' })
    expect(readFileSync(target, 'utf8')).toBe('after')
  })

  it('rejects symlink capture and quota overflow before running the effect', async () => {
    const { stateRoot, workspace } = roots('security')
    const outside = join(stateRoot, 'outside.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(workspace, 'linked.txt'))
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      maxFileBytes: 8,
    })
    const symlinkEffect = vi.fn(async () => undefined)
    await expect(
      service.capture(
        captureInput(workspace, { paths: ['linked.txt'] }),
        symlinkEffect,
      ),
    ).rejects.toMatchObject({ code: 'symlink_unsupported' })
    expect(symlinkEffect).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf8')).toBe('outside')

    writeFileSync(join(workspace, 'large.txt'), 'more-than-eight')
    const quotaEffect = vi.fn(async () => undefined)
    await expect(
      service.capture(
        captureInput(workspace, { paths: ['large.txt'] }),
        quotaEffect,
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' })
    expect(quotaEffect).not.toHaveBeenCalled()
  })

  it('enforces turn and session quotas before running later effects', async () => {
    const { stateRoot, workspace } = roots('aggregate-quota')
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      maxFileBytes: 64,
      maxTurnBytes: 10,
      maxSessionBytes: 16,
    })
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(join(workspace, name), '123456')

    await service.capture(
      captureInput(workspace, { paths: ['a.txt'], toolCallId: 'quota-a' }),
      async () => writeFileSync(join(workspace, 'a.txt'), 'abcdef'),
    )
    const turnEffect = vi.fn(async () => undefined)
    await expect(
      service.capture(
        captureInput(workspace, { paths: ['b.txt'], toolCallId: 'quota-b' }),
        turnEffect,
      ),
    ).rejects.toMatchObject({ code: 'turn_quota_exceeded' })
    expect(turnEffect).not.toHaveBeenCalled()

    await service.capture(
      captureInput(workspace, {
        paths: ['b.txt'],
        turnId: 'turn-two',
        toolCallId: 'quota-b-other-turn',
      }),
      async () => writeFileSync(join(workspace, 'b.txt'), 'ghijkl'),
    )
    const sessionEffect = vi.fn(async () => undefined)
    await expect(
      service.capture(
        captureInput(workspace, {
          paths: ['c.txt'],
          turnId: 'turn-three',
          toolCallId: 'quota-c',
        }),
        sessionEffect,
      ),
    ).rejects.toMatchObject({ code: 'session_quota_exceeded' })
    expect(sessionEffect).not.toHaveBeenCalled()
  })

  it('rejects a symlinked private checkpoint root before running the effect', async () => {
    const { stateRoot, workspace } = roots('private-root-symlink')
    const sessionRoot = join(stateRoot, 'sessions', 'session-one')
    const outsideStore = join(stateRoot, 'outside-checkpoint-store')
    mkdirSync(sessionRoot, { recursive: true })
    mkdirSync(outsideStore, { recursive: true })
    symlinkSync(outsideStore, join(sessionRoot, 'file-checkpoints'), 'dir')
    writeFileSync(join(workspace, 'file.txt'), 'before')
    const service = new FileCheckpointService({ stateRoot, enabled: true })
    const effect = vi.fn(async () => undefined)

    await expect(
      service.capture(captureInput(workspace), effect),
    ).rejects.toMatchObject({ code: 'checkpoint_storage_symlink' })
    expect(effect).not.toHaveBeenCalled()
    expect(readdirSync(outsideStore)).toEqual([])
  })

  it('detects corrupt snapshot artifacts during preview and never mutates the workspace', async () => {
    const { stateRoot, workspace } = roots('artifact-integrity')
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      inlineTextBytes: 1,
    })
    const target = join(workspace, 'binary.dat')
    writeFileSync(target, Buffer.from([0, 1, 2, 3]))
    const captured = await service.capture(
      captureInput(workspace, {
        paths: ['binary.dat'],
      }),
      async () => writeFileSync(target, Buffer.from([4, 5, 6, 7])),
    )
    const before = captured.checkpoint!.changes[0]!.before
    expect(before.storage).toBe('artifact')
    writeFileSync(
      join(
        stateRoot,
        'sessions',
        'session-one',
        'file-checkpoints',
        before.artifact!,
      ),
      Buffer.from([9, 9, 9, 9]),
    )

    await expect(
      service.preview({
        sessionId: 'session-one',
        checkpointId: captured.checkpoint!.id,
        workspaceRoot: workspace,
      }),
    ).resolves.toMatchObject({
      canRewind: false,
      conflicts: [{ path: 'binary.dat', reason: 'before_content_unavailable' }],
    })
    expect(readFileSync(target)).toEqual(Buffer.from([4, 5, 6, 7]))
  })

  it('isolates indexes containing non-portable artifact traversal', async () => {
    const { stateRoot, workspace } = roots('artifact-traversal')
    const service = new FileCheckpointService({
      stateRoot,
      enabled: true,
      inlineTextBytes: 1,
    })
    writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0, 1]))
    const captured = await service.capture(
      captureInput(workspace, { paths: ['binary.dat'] }),
      async () =>
        writeFileSync(join(workspace, 'binary.dat'), Buffer.from([2, 3])),
    )
    const indexPath = join(
      stateRoot,
      'sessions',
      'session-one',
      'file-checkpoints',
      'index.json',
    )
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    index.records[0].changes[0].before.artifact =
      'artifacts/safe\\..\\outside.bin'
    writeFileSync(indexPath, JSON.stringify(index))

    expect(await service.list('session-one')).toEqual([])
    expect(
      readdirSync(
        join(stateRoot, 'sessions', 'session-one', 'file-checkpoints'),
      ).some((name) => name.startsWith('index.json.corrupt-')),
    ).toBe(true)
    expect(captured.checkpoint).not.toBeNull()
  })

  it('reconciles a durable prepared record after restart without continuing tool execution', async () => {
    const { stateRoot, workspace } = roots('prepared-recovery')
    const target = join(workspace, 'file.txt')
    writeFileSync(target, 'after-crash')
    const checkpointRoot = join(
      stateRoot,
      'sessions',
      'session-one',
      'file-checkpoints',
    )
    mkdirSync(checkpointRoot, { recursive: true })
    const before = Buffer.from('before-crash')
    writeFileSync(
      join(checkpointRoot, 'index.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            version: 1,
            id: 'fcp_0123456789abcdef01234567',
            sessionId: 'session-one',
            turnId: 'turn-crash',
            toolCallId: 'call-crash',
            toolName: 'edit_file',
            workspaceRoot: workspace,
            createdAt: '2026-07-19T00:00:00.000Z',
            updatedAt: '2026-07-19T00:00:00.000Z',
            status: 'prepared',
            storedBytes: before.length,
            quotaTruncated: false,
            prepared: [
              {
                path: 'file.txt',
                before: {
                  state: 'file',
                  hash: createHash('sha256').update(before).digest('hex'),
                  bytes: before.length,
                  mode: 0o644,
                  storage: 'inline_text',
                  content: before.toString('utf8'),
                },
              },
            ],
            changes: [],
          },
        ],
      }),
    )
    const restarted = new FileCheckpointService({ stateRoot, enabled: true })

    await expect(
      restarted.reconcilePrepared({
        sessionId: 'session-one',
        workspaceRoot: workspace,
      }),
    ).resolves.toEqual({ recovered: 1, discarded: 0, failed: 0 })
    const [record] = await restarted.list('session-one')
    expect(record).toMatchObject({
      status: 'ready',
      changes: [{ path: 'file.txt', kind: 'modify' }],
    })
    await restarted.rewind({
      sessionId: 'session-one',
      checkpointId: record!.id,
      workspaceRoot: workspace,
    })
    expect(readFileSync(target, 'utf8')).toBe('before-crash')
  })

  it('is no-op by default, reads old sessions without creating directories, and isolates corrupt indexes', async () => {
    const { stateRoot, workspace } = roots('compat')
    const disabled = new FileCheckpointService({ stateRoot })
    const effect = vi.fn(async () => 'ok')
    const result = await disabled.capture(captureInput(workspace), effect)
    expect(result).toEqual({ value: 'ok', checkpoint: null })
    expect(effect).toHaveBeenCalledOnce()

    const enabled = new FileCheckpointService({ stateRoot, enabled: true })
    expect(await enabled.list('legacy-session')).toEqual([])
    const legacyDir = join(
      stateRoot,
      'sessions',
      'legacy-session',
      'file-checkpoints',
    )
    expect(existsSync(legacyDir)).toBe(false)

    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'index.json'), '{broken')
    expect(await enabled.list('legacy-session')).toEqual([])
    expect(
      readdirSync(legacyDir).some((name) =>
        name.startsWith('index.json.corrupt-'),
      ),
    ).toBe(true)
    expect(enabled.diagnostics().corruptIndexes).toBe(1)
  })

  it('uses stable typed errors for invalid workspace paths', async () => {
    const { stateRoot, workspace } = roots('outside')
    const service = new FileCheckpointService({ stateRoot, enabled: true })
    await expect(
      service.capture(
        captureInput(workspace, { paths: ['../escape.txt'] }),
        async () => undefined,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FileCheckpointError>>({
        code: 'path_outside_workspace',
      }),
    )
    const safe = new FileCheckpointError(
      'rewind_conflict',
      'file checkpoint rewind conflict',
    ).toSafe()
    expect(safe).toEqual({
      code: 'rewind_conflict',
      message: 'file checkpoint rewind conflict',
    })
  })
})
