import { expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { receiptFixture } from '../harness/delegation/receipt-test-fixture'
import {
  DelegationAcceptance,
  criteriaDigest,
  type AcceptanceCriteria,
} from '../harness/delegation/acceptance'
import { DelegationIntegration } from './delegation-integration'
import { fixtureGit } from './delegation-test-fixture'
async function fixture(
  beforeInstall?: (index: number, path: string) => void,
  canApply = () => true,
) {
  const f = await receiptFixture()
  writeFileSync(join(f.lease.cwd, 'src/a.txt'), 'external result')
  writeFileSync(join(f.lease.cwd, 'added.bin'), Buffer.from([0, 255, 128]))
  const receipt = await f.receipts.collect(f.run.id),
    criteria: AcceptanceCriteria = {
      description: 'text and binary are correct',
      commands: [
        {
          executable: process.execPath,
          args: [
            '-e',
            'const f=require("fs");if(f.readFileSync("src/a.txt","utf8")!=="external result" || !f.readFileSync("added.bin").equals(Buffer.from([0,255,128])))process.exit(9);console.log("integrated assertions passed")',
          ],
        },
      ],
    },
    acceptance = new DelegationAcceptance({
      root: join(f.root, 'state'),
      receipts: f.receipts,
      mutations: f.mutations,
      scope: () => ({ taskScopeId: 'task', permission: 'workspace-write' }),
    }),
    authorized = {
      source: 'host-plan' as const,
      taskScopeId: 'task',
      criteriaDigest: criteriaDigest(criteria),
    },
    accepted = await acceptance.validate(receipt.id, criteria, authorized),
    integration = new DelegationIntegration({
      root: join(f.root, 'state'),
      receipts: f.receipts,
      acceptance,
      mutations: f.mutations,
      runner: f.runner,
      scope: () => 'task',
      canApply,
      beforeInstall,
    })
  return { ...f, receipt, criteria, accepted, acceptance, integration }
}
it('tests the retained integration worktree, then applies exactly its preview without moving HEAD or index', async () => {
  const f = await fixture()
  try {
    const base = await f.integration.captureBase(f.repo),
      head = fixtureGit(f.repo, 'rev-parse', 'HEAD'),
      index = readFileSync(join(f.repo, '.git/index')),
      preview = await f.integration.previewIntegration(
        f.receipt.id,
        base,
        f.accepted.id,
      )
    expect(preview.status).toBe('ready')
    expect(preview.verificationId).toBeTruthy()
    expect(existsSync(join(preview.cwd, '.git'))).toBe(true)
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe('base')
    const applied = await f.integration.applyIntegration(
      preview.id,
      preview.revision,
      {
        source: 'host-plan',
        taskScopeId: 'task',
        previewDigest: preview.digest,
      },
    )
    expect(applied.status).toBe('applied')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe(
      'external result',
    )
    expect(readFileSync(join(f.repo, 'added.bin'))).toEqual(
      Buffer.from([0, 255, 128]),
    )
    expect(fixtureGit(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index)
  } finally {
    f.cleanup()
  }
}, 45000)
it('keeps conflicting original and external workspaces and does not produce an applicable preview', async () => {
  const f = await fixture()
  writeFileSync(join(f.repo, 'src/a.txt'), 'user conflicting edit')
  try {
    const preview = await f.integration.previewIntegration(
      f.receipt.id,
      await f.integration.captureBase(f.repo),
      f.accepted.id,
    )
    expect(preview.status).toBe('needs_user')
    expect(preview.conflicts).toContain('src/a.txt')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe(
      'user conflicting edit',
    )
    expect(readFileSync(join(f.lease.cwd, 'src/a.txt'), 'utf8')).toBe(
      'external result',
    )
    expect(existsSync(preview.cwd)).toBe(true)
  } finally {
    f.cleanup()
  }
}, 45000)
it('blocks related file drift and unauthorized preview identities before applying', async () => {
  const f = await fixture()
  try {
    const preview = await f.integration.previewIntegration(
        f.receipt.id,
        await f.integration.captureBase(f.repo),
        f.accepted.id,
      ),
      authorization = {
        source: 'host-plan' as const,
        taskScopeId: 'task',
        previewDigest: preview.digest,
      }
    await expect(
      f.integration.applyIntegration(preview.id, preview.revision, {
        ...authorization,
        previewDigest: 'different',
      }),
    ).rejects.toThrow('PERMISSION_DENIED')
    writeFileSync(join(f.repo, 'src/a.txt'), 'later user edit')
    await expect(
      f.integration.applyIntegration(
        preview.id,
        preview.revision,
        authorization,
      ),
    ).rejects.toThrow('INTEGRATION_CONFLICT')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe(
      'later user edit',
    )
  } finally {
    f.cleanup()
  }
}, 45000)
it('blocks HEAD or index drift and preserves the user Git state', async () => {
  for (const mode of ['head', 'index']) {
    const f = await fixture()
    try {
      const preview = await f.integration.previewIntegration(
        f.receipt.id,
        await f.integration.captureBase(f.repo),
        f.accepted.id,
      )
      if (mode === 'head')
        fixtureGit(f.repo, 'commit', '--allow-empty', '-qm', 'user new commit')
      else {
        writeFileSync(join(f.repo, 'user-staged.txt'), 'user index')
        fixtureGit(f.repo, 'add', 'user-staged.txt')
      }
      const head = fixtureGit(f.repo, 'rev-parse', 'HEAD'),
        index = readFileSync(join(f.repo, '.git/index'))
      await expect(
        f.integration.applyIntegration(preview.id, preview.revision, {
          source: 'host-plan',
          taskScopeId: 'task',
          previewDigest: preview.digest,
        }),
      ).rejects.toThrow('INTEGRATION_CONFLICT')
      expect(fixtureGit(f.repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index)
    } finally {
      f.cleanup()
    }
  }
}, 60000)
it('rolls back only installed files after an apply fault and retains unrelated concurrent edits', async () => {
  let repo = ''
  const f = await fixture((index) => {
    if (index === 1) {
      writeFileSync(join(repo, 'user-owned.txt'), 'concurrent user change')
      throw new Error('injected install fault')
    }
  })
  repo = f.repo
  try {
    const preview = await f.integration.previewIntegration(
      f.receipt.id,
      await f.integration.captureBase(f.repo),
      f.accepted.id,
    )
    writeFileSync(join(f.repo, 'user-owned.txt'), 'user file')
    const result = await f.integration.applyIntegration(
      preview.id,
      preview.revision,
      {
        source: 'host-plan',
        taskScopeId: 'task',
        previewDigest: preview.digest,
      },
    )
    expect(result.status).toBe('rolled_back')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe('base')
    expect(existsSync(join(f.repo, 'added.bin'))).toBe(false)
    expect(readFileSync(join(f.repo, 'user-owned.txt'), 'utf8')).toBe(
      'concurrent user change',
    )
    expect(existsSync(preview.cwd)).toBe(true)
  } finally {
    f.cleanup()
  }
}, 45000)
it('rechecks current write permission before applying a previously verified preview', async () => {
  let allowed = true
  const f = await fixture(undefined, () => allowed)
  try {
    const preview = await f.integration.previewIntegration(
      f.receipt.id,
      await f.integration.captureBase(f.repo),
      f.accepted.id,
    )
    allowed = false
    await expect(
      f.integration.applyIntegration(preview.id, preview.revision, {
        source: 'host-plan',
        taskScopeId: 'task',
        previewDigest: preview.digest,
      }),
    ).rejects.toThrow('PERMISSION_DENIED')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe('base')
  } finally {
    f.cleanup()
  }
}, 45000)
it('keeps repository context available when testing a nested project preview', async () => {
  const { delegationRepository } = await import('./delegation-test-fixture'),
    { SnapshotService } = await import('./delegation-snapshot'),
    { DelegationWorkspaceService } = await import('./delegation-workspaces'),
    { WorkspaceMutationCoordinator } = await import('./mutation-coordinator'),
    { DelegationReceipts } = await import('../harness/delegation/receipts'),
    { fixtureDelegationRecord, fixtureDelegationRun } =
      await import('../harness/delegation/testing'),
    { rmSync } = await import('node:fs')
  const f = delegationRepository(),
    mutations = new WorkspaceMutationCoordinator(),
    state = join(f.root, 'state'),
    owner = fixtureDelegationRecord().owner
  try {
    const lease = await new DelegationWorkspaceService({
        root: state,
        runner: f.runner,
        snapshots: new SnapshotService({
          runner: f.runner,
          tempRoot: join(state, 'tmp'),
          resources: mutations.resources,
        }),
        mutations,
      }).prepare(owner, {
        cwd: join(f.repo, 'src'),
        workspace: 'isolated-worktree',
        base: 'committed',
      }),
      record = {
        ...fixtureDelegationRecord(),
        cwd: lease.cwd,
        workspaceLeaseId: lease.id,
      },
      run = {
        ...fixtureDelegationRun(),
        phase: 'completed' as const,
        quiescent: true,
      },
      receipts = new DelegationReceipts({
        root: state,
        runner: f.runner,
        mutations,
        resolve: () => ({ record, run, lease }),
      })
    writeFileSync(join(lease.cwd, 'a.txt'), 'nested result')
    const receipt = await receipts.collect(run.id),
      criteria: AcceptanceCriteria = {
        description: 'nested code and repository context',
        commands: [
          {
            executable: process.execPath,
            args: [
              '-e',
              'const f=require("fs");if(f.readFileSync("a.txt","utf8")!=="nested result" || !f.readFileSync("../.gitignore","utf8").includes(".env"))process.exit(8)',
            ],
          },
        ],
      },
      acceptance = new DelegationAcceptance({
        root: state,
        receipts,
        mutations,
        scope: () => ({ taskScopeId: 'task', permission: 'workspace-write' }),
      }),
      accepted = await acceptance.validate(receipt.id, criteria, {
        source: 'host-plan',
        taskScopeId: 'task',
        criteriaDigest: criteriaDigest(criteria),
      }),
      integration = new DelegationIntegration({
        root: state,
        receipts,
        acceptance,
        mutations,
        runner: f.runner,
        scope: () => 'task',
        canApply: () => true,
      }),
      preview = await integration.previewIntegration(
        receipt.id,
        await integration.captureBase(join(f.repo, 'src')),
        accepted.id,
      )
    expect(preview.status).toBe('ready')
    expect(readFileSync(join(preview.cwd, '../.gitignore'), 'utf8')).toContain(
      '.env',
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
}, 45000)

it('reconciles an interrupted apply as needs_user without replaying writes or rolling back user edits', async () => {
  const f = await fixture()
  try {
    const preview = await f.integration.previewIntegration(
      f.receipt.id,
      await f.integration.captureBase(f.repo),
      f.accepted.id,
    )
    const directory = join(f.root, 'state/integrations', preview.id)
    writeFileSync(
      join(directory, 'preview.json'),
      JSON.stringify({
        ...preview,
        revision: 2,
        status: 'needs_user',
        reason: 'APPLY_IN_PROGRESS',
      }),
    )
    writeFileSync(
      join(directory, 'apply-intent.json'),
      JSON.stringify({
        schemaVersion: 1,
        receipt: {
          id: 'dir-interrupted',
          previewId: preview.id,
          status: 'applied',
          files: [],
        },
        operations: preview.operations,
      }),
    )
    writeFileSync(join(f.repo, 'src/a.txt'), 'user edit after crash')
    const recovered = f.integration.reconcile()
    expect(recovered).toEqual([{ previewId: preview.id, status: 'needs_user' }])
    expect(f.integration.get(preview.id).reason).toBe('APPLY_INTERRUPTED')
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe(
      'user edit after crash',
    )
    expect(f.integration.reconcile()).toEqual([])
    expect(existsSync(join(directory, 'apply-intent.json'))).toBe(true)
  } finally {
    f.cleanup()
  }
}, 45000)
