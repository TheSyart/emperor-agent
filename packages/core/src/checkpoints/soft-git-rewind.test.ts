import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  OwnedProcessRequest,
  OwnedProcessResult,
  OwnedProcessRunner,
} from '../environment/process-runner'
import {
  effectiveSoftGitRewindCapability,
  resolveSoftGitRewindMode,
  SoftGitRewindService,
  type SoftGitRewindEvaluationGateReceipt,
} from './soft-git-rewind'

const DATASET_SHA = 'a'.repeat(64)

describe('soft Git rewind capability', () => {
  it('is off by default, keeps eval read-only, and requires a runtime-bound gate for on', () => {
    const off = effectiveSoftGitRewindCapability({
      requested: resolveSoftGitRewindMode([]),
      evaluationGate: null,
      runtime: { platform: 'darwin', gitVersion: '2.55.0' },
    })
    expect(off).toMatchObject({
      requestedMode: 'off',
      effectiveMode: 'off',
      mutationAllowed: false,
      reason: 'config_off',
    })

    const evaluation = effectiveSoftGitRewindCapability({
      requested: resolveSoftGitRewindMode([
        {
          source: { kind: 'user', id: 'local', trust: 'trusted' },
          value: { mode: 'eval' },
        },
      ]),
      evaluationGate: gate(),
      runtime: { platform: 'darwin', gitVersion: '2.55.0' },
    })
    expect(evaluation).toMatchObject({
      effectiveMode: 'eval',
      mutationAllowed: false,
      reason: 'evaluation_only',
    })

    const enabled = effectiveSoftGitRewindCapability({
      requested: resolveSoftGitRewindMode([
        {
          source: { kind: 'user', id: 'local', trust: 'trusted' },
          value: { mode: 'on' },
        },
      ]),
      evaluationGate: gate(),
      runtime: { platform: 'darwin', gitVersion: '2.55.0' },
    })
    expect(enabled).toMatchObject({
      effectiveMode: 'on',
      mutationAllowed: true,
      reason: 'enabled',
      evaluationDatasetSha256: DATASET_SHA,
    })

    const mismatch = effectiveSoftGitRewindCapability({
      requested: enabled.requested,
      evaluationGate: gate({ gitVersion: '2.54.0' }),
      runtime: { platform: 'darwin', gitVersion: '2.55.0' },
    })
    expect(mismatch).toMatchObject({
      effectiveMode: 'eval',
      mutationAllowed: false,
      reason: 'runtime_mismatch',
    })
  })

  it('lets an untrusted project tighten but never enable the feature', () => {
    const resolved = resolveSoftGitRewindMode([
      {
        source: { kind: 'project', id: 'repo', trust: 'untrusted' },
        value: { mode: 'on' },
      },
    ])
    expect(resolved.value.mode).toBe('off')
    expect(resolved.trace.at(-1)?.status).toBe('rejected')
  })
})

describe('SoftGitRewindService', () => {
  it('captures a read-only checkpoint then soft-resets an ancestor with protected HEAD/index refs', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const capture = await service.capture({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
    })
    expect(capture.status).toBe('captured')
    expect(capture.head).toBe(fixture.baseHead)
    expect(runner.requests.every((request) => readOnlyGit(request.args))).toBe(
      true,
    )

    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    git(fixture.workspace, 'add', '--', 'a.txt')
    git(fixture.workspace, 'commit', '-m', 'agent change')
    const changedHead = git(fixture.workspace, 'rev-parse', 'HEAD')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture,
      fileCanRewind: true,
    })
    expect(preview).toMatchObject({
      canRewind: true,
      reason: 'ready',
      targetHead: fixture.baseHead,
      currentHead: changedHead,
      commitsToRewind: 1,
      requiresStash: false,
    })

    const result = await service.rewind({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture,
      previewRevision: preview.revision,
      dirtyStrategy: 'abort',
      confirmed: true,
      confirmedGitRisk: true,
      applyFiles: async () => {
        expect(readFileSync(join(fixture.workspace, 'a.txt'), 'utf8')).toBe(
          'after\n',
        )
        writeFileSync(join(fixture.workspace, 'a.txt'), 'before\n')
      },
    })

    expect(result.status).toBe('completed')
    expect(git(fixture.workspace, 'rev-parse', 'HEAD')).toBe(fixture.baseHead)
    expect(git(fixture.workspace, 'status', '--porcelain')).toBe('')
    expect(git(fixture.workspace, 'rev-parse', result.rescue.headRef)).toBe(
      changedHead,
    )
    expect(
      git(
        fixture.workspace,
        'reflog',
        'show',
        '--format=%H',
        result.rescue.headRef,
      ),
    ).toContain(changedHead)
    expect(
      git(fixture.workspace, 'cat-file', '-t', result.rescue.indexRef),
    ).toBe('tree')
    expect(
      runner.requests.some((request) =>
        request.args.some((arg) => arg === '--hard'),
      ),
    ).toBe(false)
    expect(
      runner.requests.some((request) =>
        request.args.some((arg) => arg === 'checkout' || arg === 'clean'),
      ),
    ).toBe(false)
  })

  it('vetoes unrelated dirty files under abort strategy before creating refs', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    writeFileSync(join(fixture.workspace, 'unrelated.txt'), 'user work\n')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    expect(preview).toMatchObject({
      canRewind: true,
      requiresStash: true,
      unrelatedDirtyPaths: ['unrelated.txt'],
    })

    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: 'fcp_0123456789abcdef01234567',
        workspaceRoot: fixture.workspace,
        managedPaths: ['a.txt'],
        capture: captureState,
        previewRevision: preview.revision,
        dirtyStrategy: 'abort',
        confirmed: true,
        confirmedGitRisk: true,
        applyFiles: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'unrelated_changes_require_stash',
    })
    expect(git(fixture.workspace, 'rev-parse', 'HEAD')).toBe(fixture.baseHead)
    expect(
      git(fixture.workspace, 'for-each-ref', 'refs/emperor-agent/rewind'),
    ).toBe('')
    expect(readFileSync(join(fixture.workspace, 'unrelated.txt'), 'utf8')).toBe(
      'user work\n',
    )
  })

  it('uses an explicitly confirmed rescue stash and restores unrelated work before soft rewind', async () => {
    const fixture = repository()
    writeFileSync(join(fixture.workspace, 'tracked-user.txt'), 'base user\n')
    git(fixture.workspace, 'add', '--', 'tracked-user.txt')
    git(
      fixture.workspace,
      '-c',
      'user.name=Emperor Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'tracked user baseline',
    )
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    writeFileSync(join(fixture.workspace, 'tracked-user.txt'), 'user edit\n')
    writeFileSync(join(fixture.workspace, 'untracked-user.txt'), 'untracked\n')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    expect(preview).toMatchObject({
      canRewind: true,
      requiresStash: true,
      stashSafe: true,
      managedDirtyPaths: ['a.txt'],
      unrelatedDirtyPaths: ['tracked-user.txt', 'untracked-user.txt'],
    })

    const result = await service.rewind({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      previewRevision: preview.revision,
      dirtyStrategy: 'stash',
      confirmed: true,
      confirmedGitRisk: true,
      applyFiles: async () =>
        writeFileSync(join(fixture.workspace, 'a.txt'), 'before\n'),
    })

    expect(result.rescue.stashOid).toMatch(/^[a-f0-9]{40,64}$/)
    expect(git(fixture.workspace, 'rev-parse', result.rescue.stashRef!)).toBe(
      result.rescue.stashOid,
    )
    expect(
      readFileSync(join(fixture.workspace, 'tracked-user.txt'), 'utf8'),
    ).toBe('user edit\n')
    expect(
      readFileSync(join(fixture.workspace, 'untracked-user.txt'), 'utf8'),
    ).toBe('untracked\n')
    expect(readFileSync(join(fixture.workspace, 'a.txt'), 'utf8')).toBe(
      'before\n',
    )
    expect(git(fixture.workspace, 'stash', 'list')).toContain(
      'emperor-agent soft rewind',
    )
  })

  it('rejects a stale preview before creating rescue refs', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    writeFileSync(join(fixture.workspace, 'late-user.txt'), 'late\n')

    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: 'fcp_0123456789abcdef01234567',
        workspaceRoot: fixture.workspace,
        managedPaths: ['a.txt'],
        capture: captureState,
        previewRevision: preview.revision,
        dirtyStrategy: 'stash',
        confirmed: true,
        confirmedGitRisk: true,
        applyFiles: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'stale_preview' })
    expect(
      git(fixture.workspace, 'for-each-ref', 'refs/emperor-agent/rewind'),
    ).toBe('')
  })

  it('vetoes a non-ancestor target and Git operations in progress', async () => {
    const fixture = repository()
    writeFileSync(join(fixture.workspace, 'a.txt'), 'captured branch\n')
    git(fixture.workspace, 'add', '--', 'a.txt')
    git(
      fixture.workspace,
      '-c',
      'user.name=Emperor Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'captured branch',
    )
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    git(fixture.workspace, 'switch', '--detach', fixture.baseHead)
    writeFileSync(join(fixture.workspace, 'other.txt'), 'other branch\n')
    git(fixture.workspace, 'add', '--', 'other.txt')
    git(
      fixture.workspace,
      '-c',
      'user.name=Emperor Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'other branch',
    )
    const divergent = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    expect(divergent).toMatchObject({
      canRewind: false,
      reason: 'target_not_ancestor',
    })

    const currentCapture = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, '.git', 'MERGE_HEAD'), '0'.repeat(40))
    const inProgress = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: currentCapture,
      fileCanRewind: true,
    })
    expect(inProgress).toMatchObject({
      canRewind: false,
      reason: 'git_operation_in_progress',
    })
  })

  it('fails closed for linked worktrees and private state placed inside the repository', async () => {
    const fixture = repository()
    const linkedRoot = join(dirname(fixture.workspace), 'linked-worktree')
    git(fixture.workspace, 'worktree', 'add', '--quiet', '--detach', linkedRoot)
    const linked = {
      ...fixture,
      workspace: linkedRoot,
      stateRoot: join(dirname(fixture.workspace), 'linked-state'),
    }
    mkdirSync(linked.stateRoot, { recursive: true })
    const linkedCapture = await capture(
      enabledService(linked, new DirectOwnedRunner()),
      linked,
    )
    expect(linkedCapture).toMatchObject({
      status: 'unavailable',
      reason: 'linked_worktree_unsupported',
    })

    const privateState = join(fixture.workspace, '.emperor-private')
    mkdirSync(privateState, { recursive: true })
    const inside = { ...fixture, stateRoot: privateState }
    const insideCapture = await capture(
      enabledService(inside, new DirectOwnedRunner()),
      inside,
    )
    expect(insideCapture).toMatchObject({
      status: 'unavailable',
      reason: 'private_state_inside_workspace_unsupported',
    })
    expect(existsSync(join(privateState, 'git-rewind'))).toBe(false)
  })

  it('rejects a symlinked private Git journal before spawning Git', async () => {
    const fixture = repository()
    const redirected = join(dirname(fixture.workspace), 'redirected-journal')
    mkdirSync(redirected, { recursive: true })
    symlinkSync(redirected, join(fixture.stateRoot, 'git-rewind'))
    const runner = new DirectOwnedRunner()
    const captured = await capture(enabledService(fixture, runner), fixture)
    expect(captured).toMatchObject({
      status: 'unavailable',
      reason: 'private_storage_symlink_unsupported',
    })
    expect(runner.requests).toHaveLength(0)
  })

  it('blocks opt-in stash when repository filters could execute project commands', async () => {
    const fixture = repository()
    git(
      fixture.workspace,
      'config',
      '--local',
      'filter.danger.clean',
      'dangerous-project-command',
    )
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    writeFileSync(join(fixture.workspace, 'unrelated.txt'), 'user\n')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    expect(preview).toMatchObject({
      canRewind: false,
      reason: 'stash_filter_unsupported',
      requiresStash: true,
      stashSafe: false,
    })
    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: 'fcp_0123456789abcdef01234567',
        workspaceRoot: fixture.workspace,
        managedPaths: ['a.txt'],
        capture: captureState,
        previewRevision: preview.revision,
        dirtyStrategy: 'stash',
        confirmed: true,
        confirmedGitRisk: true,
        applyFiles: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'stash_filter_unsupported' })
    expect(
      git(fixture.workspace, 'for-each-ref', 'refs/emperor-agent/rewind'),
    ).toBe('')
  })

  it('refuses to stash an unrelated dirty set above the bounded volume', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    writeFileSync(join(fixture.workspace, 'large-user.bin'), '')
    truncateSync(join(fixture.workspace, 'large-user.bin'), 129 * 1024 * 1024)
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })
    expect(preview).toMatchObject({
      canRewind: false,
      reason: 'stash_volume_exceeded',
      requiresStash: true,
      stashSafe: false,
    })
    expect(preview.dirtyBytes).toBeGreaterThan(128 * 1024 * 1024)
    expect(
      git(fixture.workspace, 'for-each-ref', 'refs/emperor-agent/rewind'),
    ).toBe('')
  })

  it('rolls HEAD and index back without touching the worktree when file rewind fails', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    writeFileSync(join(fixture.workspace, 'a.txt'), 'after\n')
    git(fixture.workspace, 'add', '--', 'a.txt')
    git(fixture.workspace, 'commit', '-m', 'agent change')
    const originalHead = git(fixture.workspace, 'rev-parse', 'HEAD')
    const originalIndex = git(fixture.workspace, 'write-tree')
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: true,
    })

    await expect(
      service.rewind({
        sessionId: 'session-one',
        checkpointId: 'fcp_0123456789abcdef01234567',
        workspaceRoot: fixture.workspace,
        managedPaths: ['a.txt'],
        capture: captureState,
        previewRevision: preview.revision,
        dirtyStrategy: 'abort',
        confirmed: true,
        confirmedGitRisk: true,
        applyFiles: async () => {
          throw new Error('file apply failed')
        },
      }),
    ).rejects.toMatchObject({
      code: 'file_rewind_failed',
    })
    expect(git(fixture.workspace, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(git(fixture.workspace, 'write-tree')).toBe(originalIndex)
    expect(readFileSync(join(fixture.workspace, 'a.txt'), 'utf8')).toBe(
      'after\n',
    )
    expect(git(fixture.workspace, 'status', '--porcelain')).toBe('')
  })

  it('blocks Git mutation when the file checkpoint has conflicts', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const captureState = await capture(service, fixture)
    const before = runner.requests.length
    const preview = await service.preview({
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      workspaceRoot: fixture.workspace,
      managedPaths: ['a.txt'],
      capture: captureState,
      fileCanRewind: false,
    })
    expect(preview).toMatchObject({
      canRewind: false,
      reason: 'file_conflict',
    })
    expect(runner.requests).toHaveLength(before)
  })

  it('reconciles restart journals without mutating Git or guessing an incomplete rewind', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const journalDir = join(fixture.stateRoot, 'git-rewind')
    mkdirSync(journalDir, { recursive: true })
    const transaction = (
      id: string,
      checkpointId: string,
      status: 'files_rewound' | 'head_rewound',
    ) => ({
      schemaVersion: 1,
      id,
      sessionId: 'session-one',
      checkpointId,
      workspaceDigest: createHash('sha256')
        .update(fixture.workspace)
        .digest('hex'),
      status,
      originalHead: fixture.baseHead,
      targetHead: fixture.baseHead,
      originalIndexTree: git(fixture.workspace, 'write-tree'),
      rescue: {
        transactionId: id,
        headRef: `refs/emperor-agent/rewind/${id}/head`,
        indexRef: `refs/emperor-agent/rewind/${id}/index`,
        stashRef: null,
        stashOid: null,
      },
      dirtyStrategy: 'abort',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      error: null,
    })
    writeFileSync(
      join(journalDir, 'transactions.v1.json'),
      JSON.stringify({
        schemaVersion: 1,
        transactions: [
          transaction(
            `grw_${'a'.repeat(32)}`,
            'fcp_aaaaaaaaaaaaaaaaaaaaaaaa',
            'files_rewound',
          ),
          transaction(
            `grw_${'b'.repeat(32)}`,
            'fcp_bbbbbbbbbbbbbbbbbbbbbbbb',
            'head_rewound',
          ),
        ],
      }),
    )
    const before = runner.requests.length

    await expect(
      service.reconcile({
        sessionId: 'session-one',
        workspaceRoot: fixture.workspace,
        checkpointStatuses: {
          fcp_aaaaaaaaaaaaaaaaaaaaaaaa: 'rewound',
          fcp_bbbbbbbbbbbbbbbbbbbbbbbb: 'ready',
        },
      }),
    ).resolves.toEqual({ completed: 1, interrupted: 1, unchanged: 0 })
    const journal = JSON.parse(
      readFileSync(join(journalDir, 'transactions.v1.json'), 'utf8'),
    )
    expect(
      journal.transactions.map((item: { status: string }) => item.status),
    ).toEqual(['completed', 'interrupted'])
    expect(
      runner.requests
        .slice(before)
        .map((request) => request.args)
        .flat(),
    ).not.toEqual(expect.arrayContaining(['reset', 'read-tree', 'stash']))
    expect(git(fixture.workspace, 'rev-parse', 'HEAD')).toBe(fixture.baseHead)
  })

  it('isolates a corrupt transaction journal and exposes recovery diagnostics without spawning Git', async () => {
    const fixture = repository()
    const runner = new DirectOwnedRunner()
    const service = enabledService(fixture, runner)
    const journalDir = join(fixture.stateRoot, 'git-rewind')
    const journalPath = join(journalDir, 'transactions.v1.json')
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(journalPath, '{"schemaVersion":1,"transactions":"bad"}')

    await expect(
      service.reconcile({
        sessionId: 'session-one',
        workspaceRoot: fixture.workspace,
        checkpointStatuses: {},
      }),
    ).resolves.toEqual({ completed: 0, interrupted: 0, unchanged: 0 })

    const diagnostics = service.diagnostics()
    expect(diagnostics).toMatchObject({
      requestedMode: 'on',
      corruptJournals: 1,
    })
    expect(diagnostics.lastCorruptBackup).toContain(
      'transactions.v1.json.corrupt-',
    )
    expect(existsSync(journalPath)).toBe(false)
    expect(existsSync(diagnostics.lastCorruptBackup!)).toBe(true)
    expect(runner.requests).toHaveLength(0)
  })
})

function gate(
  overrides: Partial<SoftGitRewindEvaluationGateReceipt> = {},
): SoftGitRewindEvaluationGateReceipt {
  return {
    passed: true,
    datasetSha256: DATASET_SHA,
    platform: 'darwin',
    gitVersion: '2.55.0',
    stashVerified: true,
    rollbackVerified: true,
    conflictVetoVerified: true,
    forbiddenCommandScanVerified: true,
    ...overrides,
  }
}

function repository(): {
  stateRoot: string
  workspace: string
  gitExecutable: string
  baseHead: string
} {
  const root = mkdtempSync(join(tmpdir(), 'emperor-soft-git-'))
  const stateRoot = join(root, 'state')
  const workspace = join(root, 'workspace')
  execFileSync('mkdir', ['-p', stateRoot, workspace])
  git(workspace, 'init', '--quiet')
  writeFileSync(join(workspace, 'a.txt'), 'before\n')
  git(workspace, 'add', '--', 'a.txt')
  git(
    workspace,
    '-c',
    'user.name=Emperor Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'base',
  )
  return {
    stateRoot,
    workspace,
    gitExecutable: execFileSync('/usr/bin/which', ['git'], {
      encoding: 'utf8',
    }).trim(),
    baseHead: git(workspace, 'rev-parse', 'HEAD'),
  }
}

function enabledService(
  fixture: ReturnType<typeof repository>,
  runner: DirectOwnedRunner,
): SoftGitRewindService {
  return new SoftGitRewindService({
    stateRoot: fixture.stateRoot,
    requestedMode: 'on',
    evaluationGate: gate({
      platform: process.platform,
      gitVersion: git(fixture.workspace, '--version').replace(
        'git version ',
        '',
      ),
    }),
    runtime: runner,
    platform: process.platform,
    resolveRuntime: async () => ({
      executable: fixture.gitExecutable,
      gitVersion: git(fixture.workspace, '--version').replace(
        'git version ',
        '',
      ),
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        LANG: 'C',
      },
    }),
  })
}

async function capture(
  service: SoftGitRewindService,
  fixture: ReturnType<typeof repository>,
) {
  return await service.capture({
    sessionId: 'session-one',
    checkpointId: 'fcp_0123456789abcdef01234567',
    workspaceRoot: fixture.workspace,
    managedPaths: ['a.txt'],
  })
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function readOnlyGit(args: readonly string[]): boolean {
  const command = args.find(
    (arg) =>
      !arg.startsWith('-') &&
      !arg.includes('=') &&
      !['core.hooksPath', 'core.fsmonitor', 'credential.helper'].includes(arg),
  )
  return [
    'rev-parse',
    'symbolic-ref',
    'ls-files',
    'diff',
    'status',
    'config',
    'merge-base',
    'rev-list',
  ].includes(command || '')
}

class DirectOwnedRunner implements OwnedProcessRunner {
  readonly requests: OwnedProcessRequest[] = []

  capability() {
    return {
      platform: process.platform,
      backend: 'macos-seatbelt' as const,
      status: 'available' as const,
      filesystem: 'workspace-write' as const,
      network: 'policy-controlled' as const,
      processTree: true,
      reason: 'test runner',
    }
  }

  async run(request: OwnedProcessRequest): Promise<OwnedProcessResult> {
    this.requests.push(structuredClone(request))
    const started = Date.now()
    try {
      const stdout = execFileSync(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        input: request.stdin ?? undefined,
        encoding: 'utf8',
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
      })
      return result({
        stdout,
        durationMs: Date.now() - started,
        containment: {
          decision: 'sandboxed',
          backend: 'macos-seatbelt',
          capabilityStatus: 'available',
          filesystem: 'workspace-write',
          network: 'denied',
          processTree: true,
          policyHash: createHash('sha256').update('test').digest('hex'),
          reason: '',
        },
      })
    } catch (error) {
      const failure = error as {
        status?: number | null
        stdout?: Buffer | string
        stderr?: Buffer | string
        message?: string
      }
      return result({
        exitCode: failure.status ?? null,
        stdout: String(failure.stdout ?? ''),
        stderr: String(failure.stderr ?? ''),
        error: failure.message ?? String(error),
        durationMs: Date.now() - started,
      })
    }
  }
}

function result(
  overrides: Partial<OwnedProcessResult> = {},
): OwnedProcessResult {
  return {
    status: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    error: null,
    containment: {
      decision: 'sandboxed',
      backend: 'macos-seatbelt',
      capabilityStatus: 'available',
      filesystem: 'workspace-write',
      network: 'denied',
      processTree: true,
      policyHash: createHash('sha256').update('test').digest('hex'),
      reason: '',
    },
    ...overrides,
  }
}
